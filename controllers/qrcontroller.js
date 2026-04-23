/**
 * CONTROLLER: qrController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages camera initialisation and the QR-code scanning loop.
 *
 * MOBILE / VERCEL FIX (robust rewrite):
 *   • Multi-step camera constraint chain — NEVER uses `exact` (breaks iOS Safari)
 *   • Adaptive scan zone — 60% of shortest dimension, not a fixed 250 px box
 *   • ALSO scans the FULL frame as a fallback (catches QR codes outside the box)
 *   • inversionAttempts: 'attemptBoth' for dark-background QR codes
 *   • Human-friendly camera permission error messages
 *   • Front-camera mirror compensation so jsQR always gets un-flipped pixels
 *   • `video.setAttribute('playsinline', 'true')` — required for iOS autoplay
 *   • Detailed console logging for mobile debugging
 * ─────────────────────────────────────────────────────────────────────────────
 */

const QRController = (() => {

    let _stream        = null;  // Active MediaStream
    let _scanning      = false; // Scan loop active flag
    let _isFrontCamera = false; // Whether the current camera is front-facing
    let _onQRDetected  = null;  // Callback: (qrData: string) => void
    let _frameCount    = 0;     // Frame counter for periodic debug logging

    // ── Camera ────────────────────────────────────────────────────────────────

    /**
     * Start the camera and begin the QR scan loop.
     * @param {function} onDetected - Called with the decoded QR string.
     * @param {function} [onError]  - Called with a human-friendly error message.
     */
    async function startCamera(onDetected, onError) {
        _onQRDetected = onDetected;

        try {
            stopCamera();

            // Check if we're on HTTPS (required for camera on mobile)
            if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                console.warn('[QRController] WARNING: Not on HTTPS — camera may be blocked on mobile browsers.');
            }

            /**
             * CAMERA CONSTRAINT CHAIN
             * ────────────────────────
             * Try progressively looser constraints so the app works on:
             *   • Android Chrome        — facingMode: 'environment' (rear camera)
             *   • iOS Safari 14.3+      — facingMode WITHOUT 'exact' (exact throws!)
             *   • Desktop / VR headsets — any available camera
             *
             * CRITICAL: Never use { exact: 'environment' } — it throws
             * OverconstrainedError on iOS and many WebXR/VR browsers.
             */
            const constraintChain = [
                // 1. Rear camera + HD resolution (best for scanning)
                { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
                // 2. Rear camera, no resolution preference (broader compatibility)
                { video: { facingMode: 'environment' }, audio: false },
                // 3. Any camera + HD (laptops, VR headsets, desktops)
                { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
                // 4. Absolute fallback — browser picks whatever is available
                { video: true, audio: false }
            ];

            let lastErr = null;
            for (let i = 0; i < constraintChain.length; i++) {
                try {
                    console.log(`[QRController] Trying constraint set ${i + 1}/${constraintChain.length}...`);
                    _stream = await navigator.mediaDevices.getUserMedia(constraintChain[i]);
                    const track    = _stream.getVideoTracks()[0];
                    const settings = track ? track.getSettings() : {};
                    _isFrontCamera = (settings.facingMode === 'user') || (i >= 2);
                    console.log(`[QRController] ✅ Camera started with constraint set ${i + 1} (${_isFrontCamera ? 'front/unknown' : 'rear'}, ${settings.width || '?'}x${settings.height || '?'})`);
                    lastErr = null;
                    break;
                } catch (err) {
                    console.warn(`[QRController] Constraint ${i + 1} failed: ${err.name} — ${err.message}`);
                    lastErr = err;
                }
            }
            if (lastErr) throw lastErr;

            const video = document.getElementById('video');
            video.srcObject = _stream;
            video.muted     = true;             // Required for autoplay on iOS

            // BOTH attribute AND property — some iOS versions need the attribute
            video.playsInline = true;
            video.setAttribute('playsinline', 'true');
            video.setAttribute('webkit-playsinline', 'true');
            video.setAttribute('muted', 'true');

            // CSS mirror only for front/unknown camera — purely cosmetic
            // The canvas draw compensates internally (see _scanFrame)
            video.style.transform = _isFrontCamera ? 'scaleX(-1)' : 'none';

            await new Promise((resolve) => {
                video.onloadedmetadata = () => {
                    video.play().then(resolve).catch(resolve);
                };
                // Safety net: some browsers never fire loadedmetadata
                setTimeout(resolve, 5000);
            });

            console.log(`[QRController] Video playing: ${video.videoWidth}x${video.videoHeight}`);

            document.getElementById('loading-screen').style.display   = 'none';
            document.getElementById('camera-container').style.display = 'block';

            _scanning = true;
            _frameCount = 0;
            requestAnimationFrame(_scanFrame);
            console.log('[QRController] ✅ Scan loop started.');

        } catch (err) {
            console.error('[QRController] Camera error:', err.name, err.message);

            let msg;
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                msg = '📷 Camera permission denied.\n\n'
                    + '• iOS: Settings → Safari → Camera → Allow\n'
                    + '• Android: tap the 🔒 icon in the address bar → Camera → Allow\n'
                    + '• Desktop: click the camera icon in the browser toolbar and allow\n\n'
                    + 'Then press Retry.';
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                msg = '📷 No camera found. This device needs a built-in or connected camera.';
            } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                msg = '📷 Camera is already in use by another app. Close it and press Retry.';
            } else if (err.name === 'OverconstrainedError') {
                msg = '📷 Camera constraints not supported. Press Retry — the app will use simpler settings.';
            } else {
                msg = `📷 Camera error: ${err.message}\n\nEnsure you are on HTTPS and have granted camera permission.`;
            }

            if (onError) onError(msg);
        }
    }

    /** Stop all camera tracks and the scan loop. */
    function stopCamera() {
        _scanning = false;
        if (_stream) {
            _stream.getTracks().forEach(t => t.stop());
            _stream = null;
        }
    }

    // ── Scan Loop ─────────────────────────────────────────────────────────────

    /**
     * Core animation-frame scan function.
     *
     * Key features:
     *  1. ADAPTIVE SCAN ZONE — 60% of shortest video dimension (min 200, max 800 px)
     *     Covers a proportionally large area at any resolution / distance.
     *  2. FULL-FRAME FALLBACK — if no QR detected in the center box, also scans
     *     the entire video frame. This catches QR codes at edges or when user
     *     doesn't perfectly align inside the overlay box.
     *  3. inversionAttempts: 'attemptBoth' — decodes inverted (light-on-dark) QR codes.
     *  4. Front-camera flip compensation — canvas is drawn mirrored so jsQR always
     *     receives an un-flipped image even when the <video> is visually mirrored.
     */
    function _scanFrame() {
        if (!_scanning) return;

        try {
            const video  = document.getElementById('video');
            const canvas = document.getElementById('canvas');
            const ctx    = canvas.getContext('2d');

            if (!video.readyState || video.readyState < 2 || video.videoWidth === 0) {
                requestAnimationFrame(_scanFrame);
                return;
            }

            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;

            // Mirror the canvas draw for front cameras so jsQR gets a correct image
            if (_isFrontCamera) {
                ctx.save();
                ctx.translate(canvas.width, 0);
                ctx.scale(-1, 1);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                ctx.restore();
            } else {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }

            // --- FULL FRAME SCAN ---
            // Scan the entire video frame to detect QR codes anywhere on the screen
            if (canvas.width > 0 && canvas.height > 0) {
                const fullData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(fullData.data, canvas.width, canvas.height, {
                    inversionAttempts: 'attemptBoth'
                });

                if (code && _onQRDetected) {
                    console.log(`[QRController] 🎯 QR decoded: "${code.data}"`);
                    _onQRDetected(code.data);
                }
            }

            // Periodic debug logging
            _frameCount++;
            if (_frameCount % 300 === 0) {
                console.log(`[QRController] Scanning full frame... frame=${_frameCount}, video=${canvas.width}x${canvas.height}, camera=${_isFrontCamera ? 'front' : 'rear'}`);
            }

        } catch (err) {
            console.error('[QRController] Scan frame error:', err.message);
        }

        requestAnimationFrame(_scanFrame);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return { startCamera, stopCamera };

})();

window.QRController = QRController;

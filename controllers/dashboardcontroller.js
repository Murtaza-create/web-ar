/**
 * CONTROLLER: dashboardController.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Orchestrates the main AR dashboard:
 *   • Session guard (redirect to login if not authenticated)
 *   • Machine data loading
 *   • QR detection handling
 *   • KPI panel rendering
 *   • Debug panel
 *   • Audio feedback
 * ──────────────────────────────────────────────────────────────────────────────
 */

const DashboardController = (() => {

    // ── State ─────────────────────────────────────────────────────────────────
    let _lastDetection = 0;     // Timestamp of last QR detection (for cooldown)
    let _debugMode     = false; // Debug panel visibility toggle

    // ── Debug Logging ─────────────────────────────────────────────────────────

    function _logDebug(message, type = 'info') {
        if (!_debugMode) { console.log(`[Dashboard] ${message}`); return; }

        const colors = { error: '#ff5555', success: '#00ff88', info: '#ffaa00', warning: '#ffcc00' };
        const el = document.createElement('div');
        el.style.cssText = `margin: 4px 0; color: ${colors[type] || colors.info};`;
        el.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

        const log = document.getElementById('debug-log');
        if (log) { log.appendChild(el); log.scrollTop = log.scrollHeight; }
        console.log(`[Dashboard ${type.toUpperCase()}] ${message}`);
    }

    function toggleDebug() {
        _debugMode = !_debugMode;
        const panel = document.getElementById('debug-panel');
        if (panel) panel.classList.toggle('active', _debugMode);
        _logDebug(`Debug mode ${_debugMode ? 'enabled' : 'disabled'}`);
    }

    // ── Loading / Error UI ────────────────────────────────────────────────────

    function _updateLoading(message) {
        const el = document.getElementById('loading-message');
        if (el) el.textContent = message;
    }

    function _showError(message) {
        document.getElementById('loading-screen').style.display = 'none';
        const errMsg = document.getElementById('error-message');
        // Support \n line breaks in error messages (camera permission instructions)
        if (errMsg) errMsg.style.whiteSpace = 'pre-line';
        if (errMsg) errMsg.textContent = message;
        document.getElementById('error-screen').style.display = 'flex';
    }

    function retryConnection() {
        document.getElementById('error-screen').style.display  = 'none';
        document.getElementById('loading-screen').style.display = 'flex';
        _initApp();
    }

    // ── QR Detection ──────────────────────────────────────────────────────────

    /**
     * Called by QRController each time a QR code is decoded.
     * Enforces a 2-second cooldown to avoid duplicate panels.
     * @param {string} qrData - Decoded QR string.
     */
    async function _handleQRDetected(qrData) {
        const now = Date.now();
        if (now - _lastDetection < 1000) return; // 1 s cooldown (faster switching)
        _lastDetection = now;

        _logDebug(`QR detected: ${qrData}`, 'info');

        const machine = window.MachineModel.getMachineByQR(qrData);

        if (machine) {
            _playBeep();
            const baseData = window.MachineModel.normalizeMachineRow(machine);
            
            // 1. Optimistic UI: Show base data immediately
            _showMachinePanel(baseData);
            _updateDetectionCount();

            // 2. Background Enrichment: Fetch detailed KPIs without blocking UI
            window.MachineModel.enrichMachineWithKpis(machine)
                .then(enriched => {
                    // Update panel with full data once arrived (usually < 1s now)
                    _showMachinePanel(enriched);
                })
                .catch(err => {
                    _logDebug(`Background enrichment failed: ${err.message}`, 'error');
                });
        } else {
            _logDebug(`No Supabase record for QR: "${qrData}"`, 'error');
            _showErrorPanel(`No data found for: ${qrData}`);
        }
    }

    // ── Detection Counter ─────────────────────────────────────────────────────

    function _updateDetectionCount() {
        const el = document.getElementById('detection-count');
        if (!el) return;
        el.textContent = (parseInt(el.textContent) || 0) + 1;
        el.style.color = '#00ff88';
        setTimeout(() => { el.style.color = 'white'; }, 1000);
    }

    // ── KPI Panel ─────────────────────────────────────────────────────────────

    /**
     * Render machine data into the KPI side panel.
     * @param {object} machine - Normalised + enriched machine object.
     */
    function _showMachinePanel(machine) {
        const { KPI_DEFINITIONS, normalizeMachineRow, pickKpiValue } = window.MachineModel;
        const panel   = document.getElementById('kpi-panel');
        const content = document.getElementById('panel-content');
        const m       = normalizeMachineRow(machine);

        // ── Machine info section ──────────────────────────────────────────────
        let html = `
            <div class="machine-info">
                <h3 class="machine-name">${m.name || m.machine_name || 'Unknown Machine'}</h3>
                <div class="kpi-item"><span class="kpi-label">ID:</span>       <span class="kpi-value">${m.id       || 'N/A'}</span></div>
                <div class="kpi-item"><span class="kpi-label">Type:</span>     <span class="kpi-value">${m.type     || m.machine_type || 'N/A'}</span></div>
                <div class="kpi-item"><span class="kpi-label">Status:</span>   <span class="kpi-value status-ok">${m.status   || 'Unknown'}</span></div>
                <div class="kpi-item"><span class="kpi-label">Location:</span> <span class="kpi-value">${m.location || m.area || 'N/A'}</span></div>
            </div>
        `;

        // ── KPI section ───────────────────────────────────────────────────────
        html += `<div class="kpi-section"><h4 class="section-title">Performance KPIs</h4>`;
        let kpiCount = 0;

        KPI_DEFINITIONS.forEach(def => {
            const value = pickKpiValue(m, def.keys);
            if (value !== undefined && value !== null && value !== '') {
                kpiCount++;
                html += `
                    <div class="kpi-item">
                        <span class="kpi-label">${def.label}:</span>
                        <span class="kpi-value">${value}${def.suffix}</span>
                    </div>
                `;
            }
        });

        if (kpiCount === 0) {
            html += `
                <p class="no-kpi-msg">
                    No KPI columns found. Add columns like <code>oee</code>, <code>output</code>
                    directly on the machine row, or create a related <code>machine_kpis</code>
                    table with a <code>machine_id</code> FK.
                </p>
            `;
        }
        html += `</div>`;

        // ── Maintenance section (optional) ────────────────────────────────────
        if (m.last_maintenance || m.next_service) {
            html += `<div class="kpi-section"><h4 class="section-title">Maintenance</h4>`;
            if (m.last_maintenance)
                html += `<div class="kpi-item"><span class="kpi-label">Last:</span><span class="kpi-value">${m.last_maintenance}</span></div>`;
            if (m.next_service)
                html += `<div class="kpi-item"><span class="kpi-label">Next:</span><span class="kpi-value">${m.next_service}</span></div>`;
            html += `</div>`;
        }

        content.innerHTML = html;
        panel.classList.add('active');
        _logDebug(`Panel shown for: ${m.name || m.id}`, 'success');
    }

    function hidePanel() {
        document.getElementById('kpi-panel').classList.remove('active');
    }

    /**
     * Show the QR panel in error state (QR found but no DB match).
     * @param {string} message
     */
    function _showErrorPanel(message) {
        const qrCodes = window.MachineModel.getRegisteredQRCodes().join(', ') || 'None';
        document.getElementById('panel-content').innerHTML = `
            <div class="error-panel-content">
                <div class="error-icon">⚠️</div>
                <h3>Not Found</h3>
                <p>${message}</p>
                <p class="hint">Known QR codes: ${qrCodes}</p>
            </div>
        `;
        document.getElementById('kpi-panel').classList.add('active');
    }

    // ── Audio ─────────────────────────────────────────────────────────────────

    function _playBeep() {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 800;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.2);
        } catch {
            // Audio not available — silent fail
        }
    }

    // ── Manual QR Test (Dev helper) ───────────────────────────────────────────

    function testQR(code) {
        _logDebug(`Manual QR test: ${code}`, 'info');
        _handleQRDetected(code).catch(err => _logDebug(`testQR error: ${err.message}`, 'error'));
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    async function _initApp() {
        _logDebug('=== INITIALISING APP ===', 'info');

        // 1. Camera support check
        if (!navigator.mediaDevices?.getUserMedia) {
            _showError('Your browser does not support camera access. Please use Chrome or Firefox.');
            return;
        }

        // 2. Load machine data from Supabase
        _updateLoading('Connecting to Supabase...');
        const result = await window.MachineModel.loadAllMachines();

        if (!result.success) {
            _logDebug(`Machine load failed: ${result.error}`, 'error');
            _showError(result.error || 'Failed to load machine data.');
            return;
        }

        _logDebug(`Loaded ${result.count} machines from "${result.table}"`, 'success');
        document.getElementById('machine-count').textContent = result.count;
        document.getElementById('data-source').textContent   = `Supabase (${result.table})`;

        // 3. Start camera + scan loop
        _updateLoading('Starting camera...');
        await window.QRController.startCamera(
            (qrData) => _handleQRDetected(qrData),
            (errMsg) => _showError(errMsg)
        );

        _logDebug('=== APP READY ===', 'success');
    }

    /**
     * Entry point called from dashboard.html on DOMContentLoaded.
     * Guards the page with a session check before initialising.
     */
    function init() {
        // ── Session guard ─────────────────────────────────────────────────────
        window.AuthController.checkSession();

        // ── Populate user greeting ────────────────────────────────────────────
        const session = window.AuthController.getSession();
        if (session?.user) {
            const greet = document.getElementById('user-greeting');
            if (greet) greet.textContent = `ID: ${session.user.id}`;
        }

        // ── Wire up global functions needed by inline HTML event handlers ─────
        window.hidePanel        = hidePanel;
        window.toggleDebug      = toggleDebug;
        window.retryConnection  = retryConnection;
        window.testQR           = testQR;
        window.logout           = () => window.AuthController.logout();

        _initApp();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return { init };

})();

window.DashboardController = DashboardController;

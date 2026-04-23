/**
 * CONTROLLER: authController.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles login form submission, session management, and logout.
 * Uses localStorage to persist session across page loads.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const AuthController = (() => {

    const SESSION_KEY = 'ar_session'; // localStorage key

    // ── Session Helpers ───────────────────────────────────────────────────────

    /**
     * Save user session to localStorage.
     * @param {object} user - Safe user object (no password).
     */
    function _saveSession(user) {
        const session = {
            user,
            loggedInAt: new Date().toISOString()
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    /**
     * Retrieve the current session from localStorage.
     * @returns {object|null} Session object or null if not logged in.
     */
    function getSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    /**
     * Check if a valid session exists. If not, redirect to login.html.
     * Call this at the top of any protected page.
     */
    function checkSession() {
        const session = getSession();
        if (!session) {
            window.location.href = 'login.html';
        }
    }

    /**
     * Clear the session and redirect to the login page.
     */
    function logout() {
        localStorage.removeItem(SESSION_KEY);
        window.location.href = 'login.html';
    }

    // ── Login Form Handler ────────────────────────────────────────────────────

    /**
     * Handle login form submit event.
     * Validates inputs, calls AuthModel.loginUser(), manages UI feedback.
     * @param {Event} event - The form submit event.
     */
    async function handleLoginSubmit(event) {
        event.preventDefault();

        const idInput       = document.getElementById('login-id');
        const pwInput       = document.getElementById('login-password');
        const errorDiv      = document.getElementById('login-error');
        const submitBtn     = document.getElementById('login-submit');
        const btnText       = document.getElementById('btn-text');
        const btnSpinner    = document.getElementById('btn-spinner');

        const userId   = idInput.value.trim();
        const password = pwInput.value.trim();

        // ── Basic client-side validation ──────────────────────────────────────
        if (!userId || !password) {
            _showError(errorDiv, 'Please enter both ID and password.');
            return;
        }

        // ── Show loading state ────────────────────────────────────────────────
        _setLoading(submitBtn, btnText, btnSpinner, true);
        _hideError(errorDiv);

        // ── Call Auth Model ───────────────────────────────────────────────────
        const result = await window.AuthModel.loginUser(userId, password);

        _setLoading(submitBtn, btnText, btnSpinner, false);

        if (result.success) {
            _saveSession(result.user);
            // Brief flash of success before redirect
            btnText.textContent = '✓ Logged in!';
            submitBtn.style.background = 'linear-gradient(135deg, #00ff88, #00cc6a)';
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 600);
        } else {
            _showError(errorDiv, result.error || 'Login failed. Please try again.');
            // Shake animation on the form
            const form = document.getElementById('login-form');
            form.classList.add('shake');
            setTimeout(() => form.classList.remove('shake'), 500);
        }
    }

    // ── UI Helpers ────────────────────────────────────────────────────────────
    function _showError(el, message) {
        el.textContent = message;
        el.style.display = 'block';
    }

    function _hideError(el) {
        el.style.display = 'none';
    }

    function _setLoading(btn, textEl, spinnerEl, isLoading) {
        btn.disabled         = isLoading;
        textEl.textContent   = isLoading ? 'Verifying...' : 'Login';
        spinnerEl.style.display = isLoading ? 'inline-block' : 'none';
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    /**
     * Initialise the login page.
     * If user is already logged in, skip straight to dashboard.
     */
    function initLoginPage() {
        // Already logged in? Skip login
        if (getSession()) {
            window.location.href = 'dashboard.html';
            return;
        }

        const form = document.getElementById('login-form');
        if (form) form.addEventListener('submit', handleLoginSubmit);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        initLoginPage,
        checkSession,
        getSession,
        logout
    };

})();

window.AuthController = AuthController;

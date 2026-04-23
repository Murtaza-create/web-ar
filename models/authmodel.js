/**
 * MODEL: authModel.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles all authentication database interactions.
 * Queries the "login data" table using plain-text id + password matching.
 *
 * COMMON FAILURE REASONS (all diagnosed in the console — open F12):
 *   1. RLS (Row Level Security) is ON — anon key can't read the table.
 *      Fix in Supabase → Authentication → Policies → "login data"
 *        → New Policy → "Enable read access for all users" → policy: (true)
 *   2. Table name "login data" has a space — Supabase JS handles this, but
 *      if it still fails the exact error is printed to the console.
 *   3. The "id" column might be an INTEGER, not TEXT — we try both.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const AuthModel = (() => {

    /**
     * Attempt to find a matching user in the "login data" table.
     * Open browser DevTools (F12 → Console) to see detailed step-by-step logs.
     *
     * @param {string} userId   - The value entered in the ID field.
     * @param {string} password - The value entered in the Password field.
     * @returns {Promise<{success: boolean, user: object|null, error: string|null}>}
     */
    async function loginUser(userId, password) {
        try {
            const { supabaseClient } = window.SupabaseModel;

            const trimmedId       = userId.trim();
            const trimmedPassword = password.trim();

            console.group('%c[AuthModel] Login Attempt', 'color:#00ff88;font-weight:bold');
            console.log('ID entered       :', trimmedId);
            console.log('Password entered :', trimmedPassword);

            // ── STEP 1: Can we read the table at all? ─────────────────────────
            console.log('%c── STEP 1: Testing table read access…', 'color:#ffaa00');

            const { data: testData, error: testError } = await supabaseClient
                .from('login data')
                .select('*')
                .limit(5);

            if (testError) {
                console.error('❌ Cannot read "login data"!');
                console.error('  Code   :', testError.code);
                console.error('  Message:', testError.message);
                console.error('  Hint   :', testError.hint);
                console.groupEnd();

                const isRLS = testError.code === '42501'
                    || String(testError.message).toLowerCase().includes('permission')
                    || String(testError.message).toLowerCase().includes('policy')
                    || String(testError.message).toLowerCase().includes('rls');

                return {
                    success: false,
                    user: null,
                    error: isRLS
                        ? '🔒 Permission denied. In Supabase → Authentication → Policies → "login data" → add a SELECT policy for the anon role (or disable RLS on this table).'
                        : `Database error: ${testError.message}`
                };
            }

            console.log(`✅ Table readable — ${testData?.length ?? 0} row(s) returned`);

            if (!testData || testData.length === 0) {
                console.warn('⚠️  Table is EMPTY. Add at least one row to "login data".');
                console.groupEnd();
                return {
                    success: false,
                    user: null,
                    error: 'The "login data" table is empty. Please add user records in Supabase.'
                };
            }

            // ── STEP 2: Detect actual column names ────────────────────────────
            console.log('%c── STEP 2: Detecting column names…', 'color:#ffaa00');

            const cols = Object.keys(testData[0]);
            console.log('Columns found in table:', cols);
            console.log('All rows returned     :', testData);

            // Auto-detect which column is the ID and which is the password
            const idCandidates  = ['id', 'user_id', 'username', 'user_name', 'login_id', 'userid'];
            const pwdCandidates = ['password', 'pass', 'passwd', 'pwd', 'user_password'];

            const idCol  = cols.find(c => idCandidates.includes(c.toLowerCase()))  ?? cols[0];
            const pwdCol = cols.find(c => pwdCandidates.includes(c.toLowerCase())) ?? (cols.length > 1 ? cols[1] : null);

            console.log('ID column detected       :', idCol,  '→ sample value:', testData[0][idCol]);
            console.log('Password column detected :', pwdCol, '→ sample value:', testData[0][pwdCol]);

            if (!pwdCol) {
                console.error('❌ No password column found in table!');
                console.groupEnd();
                return {
                    success: false,
                    user: null,
                    error: 'Could not find a password column in "login data". See console for column names.'
                };
            }

            // ── STEP 3: Match credentials ─────────────────────────────────────
            console.log('%c── STEP 3: Matching credentials…', 'color:#ffaa00');

            // Attempt 1 — treat id as a string (TEXT column)
            let { data: matchData, error: matchError } = await supabaseClient
                .from('login data')
                .select('*')
                .eq(idCol, trimmedId)
                .eq(pwdCol, trimmedPassword)
                .limit(1);

            console.log('Attempt 1 (id as string):', matchData, '| error:', matchError?.message ?? 'none');

            // Attempt 2 — treat id as a number (INT column), only if no match yet
            if ((!matchData || matchData.length === 0) && !matchError && !isNaN(Number(trimmedId))) {
                const numId = Number(trimmedId);
                console.log('Attempt 2 (id as number):', numId);

                const res2 = await supabaseClient
                    .from('login data')
                    .select('*')
                    .eq(idCol, numId)
                    .eq(pwdCol, trimmedPassword)
                    .limit(1);

                console.log('Attempt 2 result:', res2.data, '| error:', res2.error?.message ?? 'none');
                matchData  = res2.data;
                matchError = res2.error;
            }

            console.groupEnd();

            if (matchError) {
                return { success: false, user: null, error: `Query error: ${matchError.message}` };
            }

            if (!matchData || matchData.length === 0) {
                console.warn('No matching row — wrong ID or password.');
                return { success: false, user: null, error: 'Invalid ID or password.' };
            }

            // ── Success ───────────────────────────────────────────────────────
            // Return the user row WITHOUT the password field for security
            const { [pwdCol]: _removedPw, ...safeUser } = matchData[0];
            console.log('%c✅ Login successful!', 'color:#00ff88;font-weight:bold', safeUser);
            return { success: true, user: safeUser, error: null };

        } catch (err) {
            console.error('[AuthModel] Unexpected error:', err);
            return { success: false, user: null, error: `Unexpected error: ${err.message}` };
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return { loginUser };

})();

window.AuthModel = AuthModel;

/**
 * MODEL: machineModel.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles all machine / KPI data fetching and normalisation from Supabase.
 * Extracted and cleaned up from the original single-file AR app.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const MachineModel = (() => {

    // ── KPI field definitions ─────────────────────────────────────────────────
    // Each entry maps a human-readable label to a list of possible DB column
    // names, covering common naming conventions.
    const KPI_DEFINITIONS = [
        { label: 'OEE',         keys: ['oee', 'OEE', 'overall_oee', 'oee_percent', 'oee_pct'],                    suffix: '%'     },
        { label: 'Output',      keys: ['output', 'units_produced', 'production_count', 'units', 'production'],     suffix: ' units'},
        { label: 'Efficiency',  keys: ['efficiency', 'efficiency_percent', 'eff'],                                 suffix: '%'     },
        { label: 'Temperature', keys: ['temperature', 'temp', 'temp_c', 'temperature_c'],                         suffix: '°C'   },
        { label: 'Power Usage', keys: ['power_usage', 'power', 'power_percent', 'power_kw'],                      suffix: '%'     },
        { label: 'Speed',       keys: ['speed', 'rpm', 'spindle_speed', 'shaft_speed'],                           suffix: ' RPM' },
        { label: 'Cycle Time',  keys: ['cycle_time', 'cycle_time_sec', 'ct', 'cycle'],                            suffix: ' sec' },
        { label: 'Downtime',    keys: ['downtime', 'downtime_percent', 'downtime_pct'],                            suffix: '%'    }
    ];

    // ── Internal state ────────────────────────────────────────────────────────
    let _machinesData = [];
    let _machinesMap  = new Map(); // QR code string → machine object
    let _cachedSchema = null;      // { table, fk, orderColumn } - Saves the path that worked

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Flatten nested JSON columns and embedded FK arrays into a single flat
     * object so KPI lookups work regardless of how data is stored.
     * @param {object} row - Raw Supabase row.
     * @returns {object} Flattened row.
     */
    function normalizeMachineRow(row) {
        if (!row || typeof row !== 'object') return {};
        let out = { ...row };

        // Merge plain JSON object columns
        const jsonCols = ['metrics', 'kpis', 'kpi', 'performance', 'data', 'stats', 'telemetry', 'values'];
        for (const key of jsonCols) {
            const v = row[key];
            if (v != null && typeof v === 'object' && !Array.isArray(v)) {
                out = { ...out, ...v };
            } else if (typeof v === 'string' && v.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(v);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        out = { ...out, ...parsed };
                    }
                } catch (_) { /* ignore malformed JSON */ }
            }
        }

        // Merge embedded FK relation arrays (PostgREST select with `*`)
        const embedCols = ['machine_kpis', 'kpis', 'kpi_metrics', 'metrics'];
        for (const key of embedCols) {
            const v = row[key];
            if (Array.isArray(v) && v.length > 0) {
                out = { ...out, ...normalizeMachineRow(v[0]) };
            }
        }

        return out;
    }

    /**
     * Pick the first defined, non-empty value matching any of the given keys.
     * @param {object}   obj  - Flattened machine object.
     * @param {string[]} keys - Candidate key names to try in order.
     * @returns {*} First matching value, or undefined.
     */
    function pickKpiValue(obj, keys) {
        for (const k of keys) {
            if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        }
        return undefined;
    }

    /**
     * Fetch a single related KPI row from `table` where `fk` equals `id`.
     * Tries multiple ordering columns gracefully (some may not exist).
     * @param {string} table - Related table name.
     * @param {string} fk    - Foreign key column name.
     * @param {*}      id    - Machine id value.
     * @returns {Promise<object|null>}
     */
    async function _tryFetchRelatedKpiRow(table, fk, id) {
        const { supabaseClient } = window.SupabaseModel;
        const attempts = [
            () => supabaseClient.from(table).select('*').eq(fk, id).order('created_at',  { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).order('recorded_at', { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).order('id',          { ascending: false }).limit(1),
            () => supabaseClient.from(table).select('*').eq(fk, id).limit(1)
        ];

        for (const attempt of attempts) {
            const { data, error } = await attempt();
            if (!error && data && data.length > 0) return data[0];
        }
        return null;
    }

    /**
     * Merge data from well-known KPI-related tables into the machine object.
     * Silently skips tables that don't exist.
     * @param {object} machine - Base machine row from the machines table.
     * @returns {Promise<object>} Enriched, normalised machine object.
     */
    /**
     * Merge data from related tables into the machine object using parallel probing.
     * Drastically faster than sequential trial-and-error.
     * @param {object} machine - Base machine row.
     * @returns {Promise<object>} Enriched, normalised machine object.
     */
    async function enrichMachineWithKpis(machine) {
        let merged = normalizeMachineRow({ ...machine });
        const id = merged.id ?? merged.machine_id;

        if (id === undefined || id === null) return merged;

        // 1. Check if we already know which table/FK works
        if (_cachedSchema) {
            const { table, fk, order } = _cachedSchema;
            const { supabaseClient } = window.SupabaseModel;
            const { data, error } = await supabaseClient.from(table).select('*').eq(fk, id).order(order, { ascending: false }).limit(1);
            if (!error && data && data.length > 0) {
                return { ...merged, ...normalizeMachineRow(data[0]) };
            }
            // If cache failed (maybe schema changed?), clear and continue to full probe
            _cachedSchema = null;
        }

        const { supabaseClient } = window.SupabaseModel;
        const relatedTables = ['kpis', 'machine_kpis', 'kpi_metrics', 'metrics', 'machine_metrics', 'performance_data', 'machine_performance'];
        const foreignKeys   = ['machine_id', 'equipment_id', 'device_id'];
        const orderColumns  = ['created_at', 'recorded_at', 'id', 'updated_at'];

        console.log('[MachineModel] 🚀 Probing for KPI schema in parallel...');

        // 2. Parallel Probe Strategy:
        // We fire requests for multiple likely table names at once.
        const probes = [];
        for (const table of relatedTables) {
            for (const fk of foreignKeys) {
                probes.push((async () => {
                    // Just try the most common order or none for the probe
                    const { data, error } = await supabaseClient.from(table).select('*').eq(fk, id).limit(1);
                    if (!error && data && data.length > 0) {
                        return { table, fk, row: data[0] };
                    }
                    return null;
                })());
            }
        }

        const results = await Promise.all(probes);
        const match = results.find(r => r !== null);

        if (match) {
            const { table, fk, row } = match;
            console.log(`[MachineModel] ✅ Discovered schema: table="${table}", fk="${fk}"`);

            // Now that we have a table/fk, try to find the best order column for future use
            let bestOrder = 'id';
            for (const col of orderColumns) {
                const { error } = await supabaseClient.from(table).select(col).limit(1);
                if (!error) { bestOrder = col; break; }
            }

            _cachedSchema = { table, fk, order: bestOrder };
            return { ...merged, ...normalizeMachineRow(row) };
        }

        return merged;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async function loadAllMachines() {
        const { supabaseClient } = window.SupabaseModel;

        const tables = ['machines', 'assembly_machines', 'factory_machines', 'equipment', 'devices'];
        const selects = ['*, machine_kpis(*)', '*, kpis(*)', '*, kpi_metrics(*)', '*'];

        console.log('[MachineModel] 🚀 Probing for machines table in parallel...');

        // Parallel probe for the machines table
        const probes = tables.map(tbl => (async () => {
            for (const sel of selects) {
                try {
                    const { data, error } = await supabaseClient.from(tbl).select(sel).limit(50);
                    if (!error && data && data.length > 0) return { table: tbl, data };
                } catch (_) {}
            }
            return null;
        })());

        const results = await Promise.all(probes);
        const match = results.find(r => r !== null);

        if (!match) {
            return { success: false, count: 0, table: 'machines', error: 'No machine data found.' };
        }

        const { table: activeTable, data: machines } = match;

        // 3. Normalise and index by QR code
        _machinesData = machines.map(normalizeMachineRow);
        _machinesMap.clear();

        _machinesData.forEach(machine => {
            const qrCode = machine.qr_code || machine.qrcode || machine.code || String(machine.id) || `MACHINE_${machine.id}`;
            _machinesMap.set(qrCode, machine);
        });

        console.log(`[MachineModel] Loaded ${_machinesData.length} machines from "${activeTable}"`);
        return { success: true, count: _machinesData.length, table: activeTable, error: null };
    }

    /**
     * Look up a machine by its QR code string.
     * Tries exact → case-insensitive → partial match (in that order).
     * @param {string} qrCode - Decoded QR string.
     * @returns {object|null} Machine object or null if not found.
     */
    function getMachineByQR(qrCode) {
        // Exact match
        if (_machinesMap.has(qrCode)) return _machinesMap.get(qrCode);

        // Case-insensitive match
        for (const [key, machine] of _machinesMap.entries()) {
            if (key.toLowerCase() === qrCode.toLowerCase()) return machine;
        }

        // Partial match (QR contains key, or key contains QR)
        for (const [key, machine] of _machinesMap.entries()) {
            if (key.includes(qrCode) || qrCode.includes(key)) return machine;
        }

        console.warn(`[MachineModel] No machine found for QR: "${qrCode}"`);
        return null;
    }

    /** @returns {string[]} All registered QR codes (for debug display). */
    function getRegisteredQRCodes() {
        return Array.from(_machinesMap.keys());
    }

    return {
        KPI_DEFINITIONS,
        normalizeMachineRow,
        pickKpiValue,
        enrichMachineWithKpis,
        loadAllMachines,
        getMachineByQR,
        getRegisteredQRCodes
    };

})();

window.MachineModel = MachineModel;

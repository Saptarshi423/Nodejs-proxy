'use strict';

/**
 * hifClient.js
 *
 * Maintains a persistent ASCII TCP connection to the PNet4 HIF port (20000).
 *
 * Responsibilities:
 *  - Query CURHIALERT (1272) and CURLOALERT (1271) per measurement direction (md)
 *  - Cache the values so tcpClient can read them synchronously with no latency impact
 *  - Trigger a background re-query whenever a new md is seen in a scan packet
 *  - Auto-reconnect on close or error
 *
 * Usage (from index.js):
 *   const hifClient = require('./hifClient');
 *   hifClient.connect();
 *   hifClient.stop();
 *
 * Usage (from tcpClient.js):
 *   hifClient.ensureAlerts(md);          // trigger background fetch if not cached
 *   const { hiAlert, loAlert } = hifClient.getAlerts(md);  // synchronous cache read
 */

const net = require('net');

const DEVICE_HOST     = process.env.DEVICE_HOST        || '192.168.29.151';
const HIF_PORT        = parseInt(process.env.HIF_PORT, 10) || 20000;
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY_MS, 10) || 5000;
const QUERY_TIMEOUT   = 5000; // ms to wait for a single HIF item response

/**
 * HIF item numbers to try, in priority order.
 * CURHIALERT/CURLOALERT (1272/1271): live values from the active recipe (jux[]).
 *   Requires NEXT_ON_SPLICE feature — may not be compiled into all firmware builds.
 *   Error ^(01) = ITEM_NOT_FOUND means this item is not in this build.
 * HIALERT/LOALERT (2114/2115): recipe-level alert deviation stored in NVRAM.
 *   Fall back to these if the CUR* items are unavailable.
 */
const CURHIALERT = 1272;
const CURLOALERT = 1271;
const CURTARGET  = 1270;
const HIALERT    = 2114;
const LOALERT    = 2115;

/** Error code returned when a HIF item number does not exist in this firmware build */
const HIF_ERROR_PREFIX = '^(';

class HifClient {
    constructor() {
        /** @type {net.Socket|null} */
        this._socket       = null;

        /** Accumulates incoming ASCII bytes until a full line is received */
        this._lineBuffer   = '';

        /** Whether a reconnect timer is already scheduled */
        this._reconnecting = false;

        /** Whether the client was explicitly stopped */
        this._stopped      = false;

        /**
         * Alert value cache, keyed by md (measurement direction).
         * Value is { hiAlert: number, loAlert: number }, or null while a fetch is in flight.
         * @type {Object.<number, {hiAlert:number,loAlert:number}|null>}
         */
        this._cache = {};

        /**
         * FIFO queue of pending HIF queries.
         * Each entry: { itemNum, resolve, reject, timer }
         * Responses are matched in order — HIF is sequential, responses arrive in the same
         * order as requests, so FIFO matching by itemNum is unambiguous.
         * @type {Array<{itemNum:number, resolve:Function, reject:Function, timer:NodeJS.Timeout}>}
         */
        this._pending = [];
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /** Initiates a TCP connection to the HIF port. Safe to call multiple times. */
    connect() {
        this._stopped      = false;
        this._reconnecting = false;
        this._createSocket();
    }

    /** Cleanly stops the client and prevents further reconnection attempts. */
    stop() {
        this._stopped = true;
        if (this._socket) {
            this._socket.destroy();
            this._socket = null;
        }
        console.log(`[${new Date().toISOString()}] HifClient: stopped`);
    }

    /**
     * Returns cached alert values for the given measurement direction.
     * Returns { hiAlert: 0, loAlert: 0 } if the cache is not yet populated.
     *
     * @param {number} md  - measurement direction (= gage number in simple configurations)
     * @returns {{ hiAlert: number, loAlert: number }}
     */
    getAlerts(md) {
        const cached = this._cache[md];
        if (cached && typeof cached === 'object' && cached.hiAlert !== undefined) {
            return cached;
        }
        return { hiAlert: 0, loAlert: 0, target: 0 };
    }

    /**
     * Ensures alert values for the given md are cached.
     * If not already cached (or fetching), triggers a background HIF query.
     * Silently ignores if HIF socket is not connected.
     *
     * @param {number} md
     */
    ensureAlerts(md) {
        // null = fetch in flight, object = already cached — skip both
        if (this._cache[md] !== undefined) return;
        if (!this._socket || this._socket.destroyed) return;

        // Reserve the slot to prevent duplicate concurrent fetches
        this._cache[md] = null;

        this._fetchAlerts(md)
            .then(({ hiAlert, loAlert, target }) => {
                this._cache[md] = { hiAlert, loAlert, target };
                console.log(
                    `[${new Date().toISOString()}] HifClient: alerts cached ` +
                    `(md=${md}, hiAlert=${hiAlert}, loAlert=${loAlert}, target=${target})`
                );
            })
            .catch((err) => {
                // Release the slot so the next scan can retry
                delete this._cache[md];
                console.error(
                    `[${new Date().toISOString()}] HifClient: alert fetch failed ` +
                    `(md=${md}): ${err.message}`
                );
            });
    }

    // -------------------------------------------------------------------------
    // Private methods
    // -------------------------------------------------------------------------

    _createSocket() {
        if (this._socket) {
            this._socket.removeAllListeners();
            this._socket.destroy();
        }

        this._lineBuffer = '';
        this._cache      = {};
        this._rejectAllPending(new Error('HIF socket reset'));

        const socket = new net.Socket();
        this._socket = socket;

        socket.on('connect', () => this._onConnect());
        socket.on('data',    (chunk) => this._onData(chunk));
        socket.on('close',   (hadError) => this._onClose(hadError));
        socket.on('error',   (err) => this._onError(err));

        console.log(
            `[${new Date().toISOString()}] HifClient: connecting to ${DEVICE_HOST}:${HIF_PORT}...`
        );
        socket.connect(HIF_PORT, DEVICE_HOST);
    }

    _onConnect() {
        console.log(
            `[${new Date().toISOString()}] HifClient: connected to ${DEVICE_HOST}:${HIF_PORT}`
        );
        this._reconnecting = false;
        // Prime the cache for md=0 immediately on connect
        this.ensureAlerts(0);
    }

    _onData(chunk) {
        // RAW DIAGNOSTIC: log every byte received from the HIF port so we can
        // inspect the exact response format (hex + printable ASCII).
        console.log(
            `[${new Date().toISOString()}] HifClient: raw data received ` +
            `(bytes=${chunk.length}, hex=${chunk.toString('hex').toUpperCase()}, ` +
            `ascii=${JSON.stringify(chunk.toString('ascii'))})`
        );

        this._lineBuffer += chunk.toString('ascii');
        const lines = this._lineBuffer.split('\n');
        // Keep the last (potentially incomplete) fragment in the buffer
        this._lineBuffer = lines.pop();
        for (const line of lines) {
            this._processLine(line);
        }
    }

    /**
     * Parses one complete ASCII line from the HIF socket.
     *
     * Success format:  "1272 = 0.5000"  → resolves the pending promise with the value
     * Error format:    "        ^(01)"  → rejects the first pending promise with an error
     *
     * @param {string} line
     */
    _processLine(line) {
        // --- Error response: "        ^(NN)" ---
        if (line.includes(HIF_ERROR_PREFIX)) {
            const errMatch = line.match(/\^\((\d+)\)/);
            const code = errMatch ? parseInt(errMatch[1], 10) : -1;
            // Error codes from hif.h: 1=SYNTAX_ERROR, 2=NO_RECIPE, 6=BAD_ITEM,
            // 9=UNREC_QUALIFIER, 12=ITEM_NOT_FOUND
            const HIF_ERRORS = {
                1: 'SYNTAX_ERROR', 2: 'NO_RECIPE', 3: 'MUST_BE_RECIPE_ITEM',
                4: 'NO_RECIPE_SPACE', 6: 'BAD_ITEM', 9: 'UNREC_QUALIFIER',
                11: 'NO_RECOG', 12: 'ITEM_NOT_FOUND', 13: 'NOT_IMPLEMENTED',
            };
            const name = HIF_ERRORS[code] || `UNKNOWN(${code})`;
            console.warn(
                `[${new Date().toISOString()}] HifClient: HIF error response ` +
                `^(${code}) = ${name}`
            );
            // Reject the oldest pending query (FIFO — error corresponds to first sent command)
            if (this._pending.length > 0) {
                const [pending] = this._pending.splice(0, 1);
                clearTimeout(pending.timer);
                pending.reject(new Error(`HIF error ^(${code}) = ${name}`));
            }
            return;
        }

        // --- Success response: "1272 = 0.5000" ---
        const match = line.match(/(\d{4})\s*=\s*([-\d.eE+]+)/);
        if (!match) return;

        const itemNum = parseInt(match[1], 10);
        const value   = parseFloat(match[2]);

        // Find the first pending query for this item number (FIFO order guaranteed)
        const idx = this._pending.findIndex(p => p.itemNum === itemNum);
        if (idx === -1) return;

        const [pending] = this._pending.splice(idx, 1);
        clearTimeout(pending.timer);
        pending.resolve(value);
    }

    /**
     * Fetches hi/lo alert values for the given md.
     * First tries CURHIALERT/CURLOALERT (1272/1271) — live values from active recipe.
     * Falls back to HIALERT/LOALERT (2114/2115) if those items aren't in this firmware.
     *
     * @param {number} md
     * @returns {Promise<{hiAlert: number, loAlert: number}>}
     */
    async _fetchAlerts(md) {
        // Try CURHIALERT/CURLOALERT/CURTARGET first (live values from active recipe).
        // Send queries sequentially so a ^(01) error on one item doesn't leave
        // later items as orphaned pending entries before we fall back.
        let hiAlert, loAlert, target;
        try {
            hiAlert = await this._sendQuery(CURHIALERT, md);
            loAlert = await this._sendQuery(CURLOALERT, md);
            target  = await this._sendQuery(CURTARGET,  md);
            console.log(`[${new Date().toISOString()}] HifClient: using CURHIALERT/CURLOALERT/CURTARGET (1272/1271/1270)`);
        } catch (err) {
            console.warn(
                `[${new Date().toISOString()}] HifClient: CUR* items unavailable ` +
                `(${err.message}), falling back to HIALERT/LOALERT (2114/2115), target=0`
            );
            // Fall back to recipe-level items, also sequentially.
            // No recipe-level target item is queried — target defaults to 0 (absolute mode).
            hiAlert = await this._sendQuery(HIALERT, md);
            loAlert = await this._sendQuery(LOALERT, md);
            target  = 0;
            console.log(`[${new Date().toISOString()}] HifClient: using HIALERT/LOALERT (2114/2115)`);
        }
        return { hiAlert, loAlert, target };
    }

    /**
     * Sends a single HIF ASCII read command and returns a Promise resolving to the value.
     * Command format: "<itemNum> <md>?\r\n"
     *
     * @param {number} itemNum
     * @param {number} md
     * @returns {Promise<number>}
     */
    _sendQuery(itemNum, md) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this._pending.findIndex(p => p.resolve === resolve);
                if (idx !== -1) this._pending.splice(idx, 1);
                reject(new Error(`HIF query timeout (item=${itemNum}, md=${md})`));
            }, QUERY_TIMEOUT);

            this._pending.push({ itemNum, resolve, reject, timer });

            // HIF qualifier syntax: the md qualifier is a keyword token, not a plain
            // number. Sending "1272 0?" causes SYNTAX_ERROR (^(01)) because the lexer
            // does not accept a bare integer as an mdir qualifier.
            // For a single-MD system the device defaults to md=0 when no qualifier
            // is given, so we omit it entirely.
            const cmd = `${itemNum}?\r\n`;
            console.log(`[${new Date().toISOString()}] HifClient: sending query: ${JSON.stringify(cmd)}`);
            this._socket.write(cmd);
        });
    }

    _onClose(hadError) {
        console.log(
            `[${new Date().toISOString()}] HifClient: connection closed` +
            (hadError ? ' (due to error)' : '')
        );
        this._rejectAllPending(new Error('HIF connection closed'));
        this._scheduleReconnect();
    }

    _onError(err) {
        console.error(`[${new Date().toISOString()}] HifClient: socket error: ${err.message}`);
        // 'close' fires after 'error', reconnect is handled there
    }

    /** Rejects all pending queries and clears the queue. */
    _rejectAllPending(err) {
        for (const p of this._pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this._pending = [];
    }

    _scheduleReconnect() {
        if (this._stopped || this._reconnecting) return;
        this._reconnecting = true;
        console.log(
            `[${new Date().toISOString()}] HifClient: will reconnect in ${RECONNECT_DELAY}ms...`
        );
        setTimeout(() => {
            if (!this._stopped) this._createSocket();
        }, RECONNECT_DELAY);
    }
}

// Export a singleton — the entire application shares one HIF connection
module.exports = new HifClient();

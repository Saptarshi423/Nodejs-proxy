'use strict';

/**
 * tcpClient.js
 *
 * Maintains a persistent TCP connection to the PNet4 device on DEVICE_HOST:DEVICE_PORT.
 *
 * Responsibilities:
 *  - Accumulate incoming bytes across multiple TCP 'data' events (stream reassembly)
 *  - Detect heartbeat packets (4 bytes, value 1789 LE) and discard them
 *  - Detect 512-bucket vs 2048-bucket packet size from bkt_cnt field
 *  - Parse complete packets via parser.js
 *  - Emit 'scan', 'connected', 'disconnected' events
 *  - Auto-reconnect after RECONNECT_DELAY_MS on close or error
 *
 * Usage (from index.js):
 *   const tcpClient = require('./tcpClient');
 *   tcpClient.on('scan', (scanObj) => { ... });
 *   tcpClient.on('connected', () => { ... });
 *   tcpClient.on('disconnected', () => { ... });
 *   tcpClient.connect();
 */

const net          = require('net');
const EventEmitter = require('events');
const parser       = require('./parser');
const hifClient    = require('./hifClient');

const DEVICE_HOST       = process.env.DEVICE_HOST       || '192.168.29.203';
const DEVICE_PORT       = parseInt(process.env.DEVICE_PORT, 10)       || 25000;
const RECONNECT_DELAY   = parseInt(process.env.RECONNECT_DELAY_MS, 10) || 5000;

/**
 * TcpClient extends EventEmitter so callers can attach event listeners cleanly.
 *
 * Events emitted:
 *   'scan'         (scanObj)   — a complete scan packet was parsed successfully
 *   'connected'    ()          — TCP socket connected to device
 *   'disconnected' ()          — TCP socket closed (before any reconnect attempt)
 */
class TcpClient extends EventEmitter {
    constructor() {
        super();

        /** @type {net.Socket|null} */
        this._socket = null;

        /**
         * Accumulation buffer for incoming bytes.
         * TCP is a stream protocol; packets may arrive in fragments.
         * @type {Buffer}
         */
        this._receiveBuffer = Buffer.alloc(0);

        /** Whether a reconnect timer is already scheduled */
        this._reconnecting = false;

        /** Whether the client has been explicitly stopped */
        this._stopped = false;

        /**
         * Protocol mode detected from the heartbeat packet.
         * null  = not yet determined (no heartbeat seen)
         * true  = ProNet mode     (heartbeat big-endian,    gage# big-endian,    extProfByte_t body)
         * false = non-ProNet mode (heartbeat little-endian, gage# little-endian, raw scan_dat body)
         * @type {boolean|null}
         */
        this._pronetMode = null;
    }

    /**
     * Initiates a TCP connection to the device.
     * Safe to call multiple times; existing socket is destroyed first.
     */
    connect() {
        this._stopped = false;
        this._reconnecting = false;
        this._createSocket();
    }

    /**
     * Cleanly stops the client and prevents further reconnection attempts.
     */
    stop() {
        this._stopped = true;
        if (this._socket) {
            this._socket.destroy();
            this._socket = null;
        }
        console.log(`[${new Date().toISOString()}] TcpClient: stopped`);
    }

    // -------------------------------------------------------------------------
    // Private methods
    // -------------------------------------------------------------------------

    /**
     * Creates a new TCP socket and attaches all event handlers.
     */
    _createSocket() {
        if (this._socket) {
            // Detach listeners from the old socket before replacing it
            this._socket.removeAllListeners();
            this._socket.destroy();
        }

        // Reset the receive buffer and mode on each new connection attempt
        this._receiveBuffer = Buffer.alloc(0);
        this._pronetMode = null;

        const socket = new net.Socket();
        this._socket = socket;

        socket.on('connect', () => this._onConnect());
        socket.on('data',    (chunk) => this._onData(chunk));
        socket.on('close',   (hadError) => this._onClose(hadError));
        socket.on('error',   (err) => this._onError(err));

        console.log(
            `[${new Date().toISOString()}] TcpClient: connecting to ${DEVICE_HOST}:${DEVICE_PORT}...`
        );

        socket.connect(DEVICE_PORT, DEVICE_HOST);
    }

    /** Called when the TCP connection is established. */
    _onConnect() {
        console.log(
            `[${new Date().toISOString()}] TcpClient: connected to ${DEVICE_HOST}:${DEVICE_PORT}`
        );
        this._reconnecting = false;
        this.emit('connected');
    }

    /**
     * Called for every incoming data chunk from the TCP stream.
     * Appends to the internal receive buffer and attempts to parse packets.
     *
     * @param {Buffer} chunk
     */
    _onData(chunk) {
        // RAW DIAGNOSTIC: log every chunk received from the device
        // console.log(
        //     `[${new Date().toISOString()}] TcpClient: raw chunk received ` +
        //     `(bytes=${chunk.length}, hex=${chunk.slice(0, 16).toString('hex').toUpperCase()}...)`
        // );

        // Append incoming bytes to the accumulation buffer
        this._receiveBuffer = Buffer.concat([this._receiveBuffer, chunk]);

        // Process as many complete packets as possible from the buffer
        this._processBuffer();
    }

    /**
     * Attempts to extract and parse one or more complete packets from _receiveBuffer.
     * Called after every 'data' event.
     *
     * Protocol state machine:
     *   1. Need at least 4 bytes to identify packet type.
     *   2. Check for Java stream header (0xACED000C) — sent by device on every new
     *      connection before any data. Skip it silently.
     *   3. Check for heartbeat (value 1789):
     *      - Non-ProNet mode: little-endian bytes FD 06 00 00
     *      - ProNet mode:     big-endian bytes    00 00 06 FD
     *      Discard both forms.
     *   4. Peek at first 4 bytes as uint32BE for gage number (valid range 0-6).
     *   5. If gage packet:
     *      - Need at least 64 bytes to read bkt_cnt at offset 62.
     *      - Once bkt_cnt is known, wait for the full packet size.
     *      - Parse and emit 'scan' event.
     *   6. Slice off consumed bytes and loop.
     */
    _processBuffer() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const buf = this._receiveBuffer;
            //console.log(buf.length);
            if (buf.length < 4) {
                // Not enough data yet
                break;
            }

            // --- Java stream header detection ---
            // Device sends 0xACED000C (magic 0xACED + version 12) immediately on
            // connection via writeStreamHeader(). Skip it silently.
            if (buf.readUInt32BE(0) === 0xACED000C) {
                console.log(`[${new Date().toISOString()}] TcpClient: Java stream header received (0xACED000C), skipping`);
                this._receiveBuffer = buf.slice(4);
                continue;
            }

            // --- Heartbeat detection (both endian forms) ---
            // Non-ProNet mode: writeInt(port, 1789, NO_ENDSWAP) → little-endian → FD 06 00 00
            // ProNet mode:     writeInt(port, 1789, ENDSWAP)    → big-endian    → 00 00 06 FD
            const isHbLE = buf.readUInt32LE(0) === 1789; // non-ProNet
            const isHbBE = buf.readUInt32BE(0) === 1789; // ProNet
            if (isHbLE || isHbBE) {
                // First heartbeat seen — lock in the protocol mode for this connection
                if (this._pronetMode === null) {
                    this._pronetMode = isHbBE;
                    console.log(
                        `[${new Date().toISOString()}] TcpClient: protocol mode detected: ` +
                        `${this._pronetMode ? 'ProNet (big-endian)' : 'non-ProNet (little-endian, raw scan_dat)'}`
                    );
                }
                console.log(
                    `[${new Date().toISOString()}] TcpClient: heartbeat received ` +
                    `(${isHbBE ? 'ProNet/big-endian' : 'non-ProNet/little-endian'}), discarding`
                );
                this._receiveBuffer = buf.slice(4);
                continue;
            }

            // --- Gage packet detection ---
            // Gage number endianness depends on protocol mode.
            // If mode not yet known (no heartbeat seen), wait for more data.
            if (this._pronetMode === null) {
                break; // Wait until heartbeat reveals the protocol mode
            }

            const gageNo = this._pronetMode
                ? buf.readUInt32BE(0)   // ProNet: big-endian
                : buf.readUInt32LE(0);  // non-ProNet: little-endian

            if (gageNo > 6) {
                // Unexpected leading bytes — log and discard one byte to re-sync
                console.warn(
                    `[${new Date().toISOString()}] TcpClient: unexpected byte sequence ` +
                    `(hex=${buf.slice(0, 4).toString('hex').toUpperCase()}), discarding 1 byte to re-sync`
                );
                this._receiveBuffer = buf.slice(1);
                continue;
            }

            // Determine packet size based on protocol mode
            let packetSize;
            if (this._pronetMode) {
                // ProNet: need ≥64 bytes to read bkt_cnt at offset 62
                if (buf.length < 64) break;
                const bktCnt = parser.peekBktCnt(buf);
                packetSize   = parser.expectedPacketSize(bktCnt);
            } else {
                // non-ProNet: fixed size = 4 (gage#) + sizeof(scan_dat) = 10390 bytes
                packetSize = parser.PACKET_SIZE_NONPRONET;
            }

            if (buf.length < packetSize) {
                // console.log(
                //     `[${new Date().toISOString()}] TcpClient: accumulating packet ` +
                //     `(gage=${gageNo}, ${buf.length}/${packetSize} bytes, ` +
                //     `mode=${this._pronetMode ? 'ProNet' : 'non-ProNet'})`
                // );
                break; // Full packet not yet received — wait for more data
            }

            // Extract the full packet slice
            const packetBuf = buf.slice(0, packetSize);

            // Log raw profile data received off the wire (before parsing)
            // console.log(
            //     `[${new Date().toISOString()}] TcpClient: raw profile data received ` +
            //     `(gage=${gageNo}, bytes=${packetSize}, ` +
            //     `mode=${this._pronetMode ? 'ProNet' : 'non-ProNet'}, ` +
            //     `firstBytes=${packetBuf.slice(0, 8).toString('hex').toUpperCase()})`
            // );

            try {
                const scanObj = this._pronetMode
                    ? parser.parseProNetPacket(packetBuf)
                    : parser.parseNonProNetPacket(packetBuf);

                // Ensure HIF has alert values cached for this gage's md.
                // If not yet cached, triggers a background fetch for future scans.
                hifClient.ensureAlerts(scanObj.gage);

                // Merge cached alert thresholds into the scan object.
                // Returns { hiAlert: 0, loAlert: 0 } until the first HIF response arrives.
                const { hiAlert, loAlert, target } = hifClient.getAlerts(scanObj.gage);
                scanObj.hiAlert = hiAlert;
                scanObj.loAlert = loAlert;
                scanObj.target  = target;

                // console.log(
                //     `[${new Date().toISOString()}] TcpClient: parsed scan ` +
                //     `(gage=${scanObj.gage}, avg=${scanObj.avg.toFixed(4)}, ` +
                //     `bktCnt=${scanObj.bktCnt}, totalCnt=${scanObj.totalCnt}, ` +
                //     `noDataFlag=${scanObj.noDataFlag}, hiAlert=${hiAlert}, loAlert=${loAlert}, ` +
                //     `bytes=${packetSize})`
                // );
                console.log(JSON.stringify(scanObj, null, 2));
                this.emit('scan', scanObj);
            } catch (err) {
                console.error(
                    `[${new Date().toISOString()}] TcpClient: parse error: ${err.message}`
                );
            }

            // Consume the packet bytes from the buffer
            this._receiveBuffer = buf.slice(packetSize);
        }
    }

    /**
     * Called when the TCP socket closes.
     *
     * @param {boolean} hadError
     */
    _onClose(hadError) {
        console.log(
            `[${new Date().toISOString()}] TcpClient: connection closed` +
            (hadError ? ' (due to error)' : '')
        );
        this.emit('disconnected');
        this._scheduleReconnect();
    }

    /**
     * Called when the TCP socket emits an error.
     * The 'close' event will follow automatically, so reconnect is handled there.
     *
     * @param {Error} err
     */
    _onError(err) {
        console.error(`[${new Date().toISOString()}] TcpClient: socket error: ${err.message}`);
        // Do not call _scheduleReconnect() here — 'close' fires after 'error'
    }

    /**
     * Schedules a reconnection attempt after RECONNECT_DELAY milliseconds.
     * No-op if already reconnecting or if the client was explicitly stopped.
     */
    _scheduleReconnect() {
        if (this._stopped || this._reconnecting) return;

        this._reconnecting = true;
        console.log(
            `[${new Date().toISOString()}] TcpClient: will reconnect in ${RECONNECT_DELAY}ms...`
        );

        setTimeout(() => {
            if (!this._stopped) {
                this._createSocket();
            }
        }, RECONNECT_DELAY);
    }
}

// Export a singleton instance — the entire application shares one TCP connection
module.exports = new TcpClient();

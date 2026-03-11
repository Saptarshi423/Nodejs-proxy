'use strict';

/**
 * measClient.js
 *
 * Maintains a persistent TCP connection to the PNet4 device on DEVICE_HOST:MEAS_PORT (25001).
 * Receives continuous INLINE gage readings — one raw measurement value per gage sensor
 * every ~20-50ms.
 *
 * Responsibilities:
 *  - Send Java stream handshake (0xACED + PROTOCOL_VERSION) on connect
 *  - Accumulate incoming bytes across multiple TCP 'data' events (stream reassembly)
 *  - Parse dynamic-length packets: 8-byte header (gageNo + numItems) + numItems * 44 bytes
 *  - Emit 'meas', 'connected', 'disconnected' events
 *  - Auto-reconnect after RECONNECT_DELAY_MS on close or error
 *
 * Usage (from index.js):
 *   const measClient = require('./measClient');
 *   measClient.on('meas', ({ gageNo, readings }) => { ... });
 *   measClient.on('connected', () => { ... });
 *   measClient.on('disconnected', () => { ... });
 *   measClient.connect();
 */

const net          = require('net');
const EventEmitter = require('events');
const { parseMeasBatch } = require('./parser');

const DEVICE_HOST     = process.env.DEVICE_HOST       || '192.168.29.203';
const MEAS_PORT       = parseInt(process.env.MEAS_PORT, 10)        || 25001;
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY_MS, 10) || 5000;

/**
 * Java ObjectOutputStream stream header constants.
 * The device sends these two shorts at the start of every new connection
 * before any data packets (same as port 25000).
 */
const MAGIC   = 0xACED;
const VERSION = 0x0005; // PROTOCOL_VERSION used by PNet4

/** Size of each Meas item in bytes */
const MEAS_ITEM_SIZE = 44;

/** Size of the packet header (gageNo + numItems) */
const MEAS_HEADER_SIZE = 8;

/**
 * MeasClient extends EventEmitter so callers can attach event listeners cleanly.
 *
 * Events emitted:
 *   'meas'         ({ gageNo, readings })  — a complete batch of INLINE readings
 *   'connected'    ()                      — TCP socket connected and handshake validated
 *   'disconnected' ()                      — TCP socket closed (before any reconnect attempt)
 */
class MeasClient extends EventEmitter {
    constructor() {
        super();

        /** @type {net.Socket|null} */
        this._socket = null;

        /**
         * Accumulation buffer for incoming bytes.
         * @type {Buffer}
         */
        this._receiveBuffer = Buffer.alloc(0);

        /** Whether a reconnect timer is already scheduled */
        this._reconnecting = false;

        /** Whether the client has been explicitly stopped */
        this._stopped = false;

        /**
         * Whether the stream header handshake has been sent on the current connection.
         * Reset to false on each new socket creation.
         */
        this._handshakeSent = false;
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
        console.log(`[${new Date().toISOString()}] MeasClient: stopped`);
    }

    // -------------------------------------------------------------------------
    // Private methods
    // -------------------------------------------------------------------------

    /**
     * Creates a new TCP socket and attaches all event handlers.
     */
    _createSocket() {
        if (this._socket) {
            this._socket.removeAllListeners();
            this._socket.destroy();
        }

        this._receiveBuffer = Buffer.alloc(0);
        this._handshakeSent = false;

        const socket = new net.Socket();
        this._socket = socket;

        socket.on('connect', () => this._onConnect());
        socket.on('data',    (chunk) => this._onData(chunk));
        socket.on('close',   (hadError) => this._onClose(hadError));
        socket.on('error',   (err) => this._onError(err));

        console.log(
            `[${new Date().toISOString()}] MeasClient: connecting to ${DEVICE_HOST}:${MEAS_PORT}...`
        );

        socket.connect(MEAS_PORT, DEVICE_HOST);
    }

    /**
     * Called when the TCP connection is established.
     * Sends the Java ObjectOutputStream stream header handshake.
     */
    _onConnect() {
        console.log(
            `[${new Date().toISOString()}] MeasClient: connected to ${DEVICE_HOST}:${MEAS_PORT}`
        );
        this._reconnecting = false;

        // Send Java stream header: short magic (0xACED) + short version (0x0005)
        const handshake = Buffer.alloc(4);
        handshake.writeUInt16BE(MAGIC,   0);
        handshake.writeUInt16BE(VERSION, 2);
        this._socket.write(handshake);
        this._handshakeSent = true;

        console.log(
            `[${new Date().toISOString()}] MeasClient: handshake sent (0xACED 0x${VERSION.toString(16).toUpperCase()})`
        );

        this.emit('connected');
    }

    /**
     * Called for every incoming data chunk from the TCP stream.
     *
     * @param {Buffer} chunk
     */
    _onData(chunk) {
        this._receiveBuffer = Buffer.concat([this._receiveBuffer, chunk]);
        this._processBuffer();
    }

    /**
     * Attempts to extract and parse one or more complete INLINE packets from _receiveBuffer.
     *
     * Packet layout:
     *   int  gageNo    (4 bytes BE) — which gage sent this batch
     *   int  numItems  (4 bytes BE) — number of Meas items
     *   [numItems × 44 bytes]       — Meas items (see parseMeasBatch in parser.js)
     *
     * Total packet size = 8 + numItems × 44  (dynamic)
     */
    _processBuffer() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const buf = this._receiveBuffer;

            // Need at least 8 bytes to read the header (gageNo + numItems)
            if (buf.length < MEAS_HEADER_SIZE) break;

            // --- Java stream header detection ---
            // Device sends 0xACED000C (magic 0xACED + version 12) immediately on
            // every new connection before any data. Skip it silently.
            if (buf.readUInt32BE(0) === 0xACED000C) {
                console.log(`[${new Date().toISOString()}] MeasClient: Java stream header received (0xACED000C), skipping`);
                this._receiveBuffer = buf.slice(4);
                continue;
            }

            const numItems       = buf.readInt32BE(4);
            const totalPacketSize = MEAS_HEADER_SIZE + numItems * MEAS_ITEM_SIZE;

            // Wait until the full packet has arrived
            if (buf.length < totalPacketSize) break;

            // Extract the complete packet slice and parse it
            const packetBuf = buf.slice(0, totalPacketSize);

            try {
                const batch = parseMeasBatch(packetBuf);
                //console.log({meas:JSON.stringify(batch)});
                this.emit('meas', batch);
            } catch (err) {
                console.error(
                    `[${new Date().toISOString()}] MeasClient: parse error: ${err.message}`
                );
            }

            // Consume the packet bytes; keep any remainder for the next iteration
            this._receiveBuffer = buf.slice(totalPacketSize);
        }
    }

    /** Called when the TCP socket closes. */
    _onClose(hadError) {
        console.log(
            `[${new Date().toISOString()}] MeasClient: connection closed` +
            (hadError ? ' (due to error)' : '')
        );
        this.emit('disconnected');
        this._scheduleReconnect();
    }

    /**
     * Called when the TCP socket emits an error.
     * The 'close' event fires after 'error', so reconnect is handled there.
     *
     * @param {Error} err
     */
    _onError(err) {
        console.error(`[${new Date().toISOString()}] MeasClient: socket error: ${err.message}`);
    }

    /**
     * Schedules a reconnection attempt after RECONNECT_DELAY milliseconds.
     * No-op if already reconnecting or if the client was explicitly stopped.
     */
    _scheduleReconnect() {
        if (this._stopped || this._reconnecting) return;

        this._reconnecting = true;
        console.log(
            `[${new Date().toISOString()}] MeasClient: will reconnect in ${RECONNECT_DELAY}ms...`
        );

        setTimeout(() => {
            if (!this._stopped) {
                this._createSocket();
            }
        }, RECONNECT_DELAY);
    }
}

// Export a singleton instance
module.exports = new MeasClient();

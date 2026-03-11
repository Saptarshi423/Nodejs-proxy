'use strict';

/**
 * index.js
 *
 * Entry point for the PNet4 proxy server.
 *
 * Wires together:
 *   - tcpClient  → connects to PNet4 device, parses binary scan packets
 *   - trendStore → stores scan history in-memory ring buffers
 *   - wsServer   → broadcasts scan data to connected React clients via WebSocket
 *   - restApi    → exposes trend history and health via HTTP REST
 *
 * Startup sequence:
 *   1. Load environment variables from .env
 *   2. Start WebSocket server
 *   3. Start REST API server
 *   4. Start TCP client (connect to device)
 *   5. Wire up event listeners
 */

// Load environment variables from .env BEFORE any other module reads process.env
require('dotenv').config();

const tcpClient  = require('./tcpClient');
const measClient = require('./measClient');
const hifClient  = require('./hifClient');
const trendStore = require('./trendStore');
const measStore  = require('./measStore');
const wsServer   = require('./wsServer');
const restApi    = require('./restApi');

// -------------------------------------------------------------------------
// Start servers
// -------------------------------------------------------------------------

wsServer.start();
restApi.start();

// -------------------------------------------------------------------------
// Wire TCP client events
// -------------------------------------------------------------------------

/**
 * 'scan' — fired for every successfully parsed scan packet.
 * Store in trend history and broadcast to WebSocket clients.
 */
tcpClient.on('scan', (scanObj) => {
    trendStore.addPoint(scanObj);
    wsServer.broadcast(scanObj);
});

/**
 * 'connected' — fired when the TCP socket connects to the device.
 */
tcpClient.on('connected', () => {
    console.log(`[${new Date().toISOString()}] Device connection established`);
    restApi.setDeviceConnected(true);
});

/**
 * 'disconnected' — fired when the TCP socket closes (before reconnect attempt).
 */
tcpClient.on('disconnected', () => {
    console.log(`[${new Date().toISOString()}] Device connection lost`);
    restApi.setDeviceConnected(false);
});

// -------------------------------------------------------------------------
// Wire INLINE meas client events (port 25001)
// -------------------------------------------------------------------------

/**
 * 'meas' — fired for every parsed INLINE batch.
 * Store all readings in the meas ring buffer.
 */
measClient.on('meas', ({ gageNo, readings }) => {
    measStore.addReadings(gageNo, readings);
});

/**
 * 'connected' / 'disconnected' — update /health status for meas port.
 */
measClient.on('connected', () => {
    console.log(`[${new Date().toISOString()}] Meas connected`);
    restApi.setMeasConnected(true);
});

measClient.on('disconnected', () => {
    console.log(`[${new Date().toISOString()}] Meas connection lost`);
    restApi.setMeasConnected(false);
});

/**
 * Throttled WebSocket push — broadcast the latest reading per gage
 * at most once every MEAS_BROADCAST_MS milliseconds.
 */
const MEAS_BROADCAST_MS = parseInt(process.env.MEAS_BROADCAST_MS, 10) || 1000;

setInterval(() => {
    for (let g = 0; g < 7; g++) {
        const history = measStore.getHistory(g);
        //console.log(history.length)
        if (history.length === 0) continue;
        const latest = history[history.length - 1];
        //wsServer.broadcast({ type: 'meas', gage: g, ...latest });
    }
}, MEAS_BROADCAST_MS);

// -------------------------------------------------------------------------
// Start TCP client (connect to device)
// -------------------------------------------------------------------------

tcpClient.connect();
measClient.connect();
hifClient.connect();

// -------------------------------------------------------------------------
// Startup banner
// -------------------------------------------------------------------------

const DEVICE_HOST     = process.env.DEVICE_HOST     || '192.168.29.203';
const DEVICE_PORT     = process.env.DEVICE_PORT     || '25000';
const WS_PORT         = process.env.WS_PORT         || '8080';
const REST_PORT       = process.env.REST_PORT       || '3001';
const MAX_TREND_PTS   = process.env.MAX_TREND_POINTS || '101';
const RECONNECT_DELAY = process.env.RECONNECT_DELAY_MS || '5000';

console.log(`
╔══════════════════════════════════════════════════════╗
║             PNet4 Proxy Server Started               ║
╠══════════════════════════════════════════════════════╣
║  Device     : ${DEVICE_HOST}:${DEVICE_PORT}          ║
║  WebSocket  : ws://localhost:${WS_PORT}              ║
║  REST API   : http://localhost:${REST_PORT}          ║
║  Trend pts  : ${MAX_TREND_PTS} per gage              ║
║  Reconnect  : ${RECONNECT_DELAY}ms                   ║
╚══════════════════════════════════════════════════════╝
`);

// -------------------------------------------------------------------------
// Graceful shutdown
// -------------------------------------------------------------------------

/**
 * Handle SIGINT (Ctrl+C) and SIGTERM cleanly.
 * Stops the TCP client to avoid leaving dangling socket handles.
 */
function shutdown(signal) {
    console.log(`\n[${new Date().toISOString()}] Received ${signal} — shutting down gracefully...`);
    tcpClient.stop();
    measClient.stop();
    hifClient.stop();
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Catch any unhandled promise rejections so the process doesn't crash silently.
 */
process.on('unhandledRejection', (reason, promise) => {
    console.error(
        `[${new Date().toISOString()}] Unhandled promise rejection at:`,
        promise,
        'reason:',
        reason
    );
});

/**
 * Catch any uncaught synchronous exceptions.
 */
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] Uncaught exception: ${err.message}`);
    console.error(err.stack);
    // Do not exit — let the process keep running for embedded/industrial use
});

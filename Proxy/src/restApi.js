'use strict';

/**
 * restApi.js
 *
 * Express REST API that exposes trend history and health status for the PNet4 proxy.
 *
 * Endpoints:
 *   GET    /health         → { status, connectedToDevice, wsClients, uptime }
 *   GET    /trend          → all gages history
 *   GET    /trend/:gage    → history for a specific gage (0-6)
 *   DELETE /trend/:gage    → clear history for a specific gage (0-6)
 */

const express = require('express');
const cors    = require('cors');

const trendStore = require('./trendStore');
const wsServer   = require('./wsServer');

const REST_PORT = parseInt(process.env.REST_PORT, 10) || 3001;

/** Tracks whether the TCP connection to the device is currently active */
let _deviceConnected = false;

/** Server start time for uptime reporting */
const _startTime = Date.now();

const app = express();

// --- Middleware ---

// Enable CORS for all origins (React dev server on a different port needs this)
app.use(cors());

// Parse JSON request bodies (useful for future POST endpoints)
app.use(express.json());

// --- Routes ---

/**
 * GET /health
 * Returns the operational status of the proxy server.
 */
app.get('/health', (req, res) => {
    res.json({
        status:             'ok',
        connectedToDevice:  _deviceConnected,
        wsClients:          wsServer.getClientCount(),
        uptimeSeconds:      Math.floor((Date.now() - _startTime) / 1000),
        serverTime:         new Date().toISOString(),
    });
});

/**
 * GET /trend
 * Returns trend history for all gages (0-6).
 */
app.get('/trend', (req, res) => {
    res.json({
        status: 'ok',
        data:   trendStore.getAllGages(),
    });
});

/**
 * GET /trend/:gage
 * Returns trend history for a specific gage number (0-6).
 */
app.get('/trend/:gage', (req, res) => {
    const gageNo = parseInt(req.params.gage, 10);

    if (isNaN(gageNo) || gageNo < 0 || gageNo >= trendStore.GAGE_COUNT) {
        return res.status(400).json({
            status:  'error',
            message: `Invalid gage number. Must be 0-${trendStore.GAGE_COUNT - 1}.`,
        });
    }

    res.json({
        status:  'ok',
        gage:    gageNo,
        count:   trendStore.getCount(gageNo),
        maxPoints: trendStore.MAX_POINTS,
        data:    trendStore.getHistory(gageNo),
    });
});

/**
 * DELETE /trend/:gage
 * Clears the trend history for a specific gage number.
 */
app.delete('/trend/:gage', (req, res) => {
    const gageNo = parseInt(req.params.gage, 10);

    if (isNaN(gageNo) || gageNo < 0 || gageNo >= trendStore.GAGE_COUNT) {
        return res.status(400).json({
            status:  'error',
            message: `Invalid gage number. Must be 0-${trendStore.GAGE_COUNT - 1}.`,
        });
    }

    trendStore.clear(gageNo);
    console.log(`[${new Date().toISOString()}] REST API: cleared trend history for gage ${gageNo}`);

    res.json({
        status:  'ok',
        message: `Trend history cleared for gage ${gageNo}.`,
    });
});

/**
 * Catch-all 404 handler for undefined routes.
 */
app.use((req, res) => {
    res.status(404).json({
        status:  'error',
        message: `Route ${req.method} ${req.path} not found.`,
    });
});

/**
 * Global error handler.
 */
app.use((err, req, res, _next) => {
    console.error(`[${new Date().toISOString()}] REST API error: ${err.message}`);
    res.status(500).json({
        status:  'error',
        message: 'Internal server error',
    });
});

/**
 * Starts the REST API server listening on REST_PORT.
 * Called once from index.js at startup.
 */
function start() {
    app.listen(REST_PORT, () => {
        console.log(`[${new Date().toISOString()}] REST API listening on http://localhost:${REST_PORT}`);
    });
}

/**
 * Updates the device connection state.
 * Called by tcpClient.js when the TCP connection opens or closes.
 *
 * @param {boolean} connected
 */
function setDeviceConnected(connected) {
    _deviceConnected = connected;
}

module.exports = {
    start,
    setDeviceConnected,
};

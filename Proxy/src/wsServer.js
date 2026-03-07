'use strict';

/**
 * wsServer.js
 *
 * WebSocket server that broadcasts parsed PNet4 scan data to connected clients.
 *
 * Behavior:
 *  - Listens on WS_PORT (default 8080)
 *  - Sends a 'hello' message when a new client connects
 *  - Sends full trend history on new client connection (type: 'history')
 *  - Broadcasts each new scan event as JSON (type: 'scan') to all clients
 *  - Logs client connect / disconnect events with timestamps
 */

const WebSocket = require('ws');
const trendStore = require('./trendStore');

const WS_PORT = parseInt(process.env.WS_PORT, 10) || 8080;

/** @type {WebSocket.Server} */
let wss = null;

/**
 * Initializes and starts the WebSocket server.
 * Should be called once at startup from index.js.
 */
function start() {
    wss = new WebSocket.Server({ port: WS_PORT });

    console.log(`[${new Date().toISOString()}] WebSocket server listening on ws://localhost:${WS_PORT}`);

    wss.on('connection', (ws, req) => {
        const clientAddress = req.socket.remoteAddress || 'unknown';
        console.log(`[${new Date().toISOString()}] WebSocket: client connected from ${clientAddress}`);

        // Send a welcome/hello message
        _sendToClient(ws, {
            type: 'hello',
            message: 'PNet4 Proxy connected',
            serverTime: new Date().toISOString(),
        });

        //Send full trend history so the client can populate its charts immediately
        _sendToClient(ws, {
            type: 'history',
            data: trendStore.getAllGages(),
        });

        ws.on('close', (code, reason) => {
            console.log(
                `[${new Date().toISOString()}] WebSocket: client ${clientAddress} disconnected` +
                ` (code=${code}, reason=${reason || 'none'})`
            );
        });

        ws.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] WebSocket: client ${clientAddress} error: ${err.message}`);
        });

        // Handle any messages received from the client (reserved for future use)
        ws.on('message', (data) => {
            console.log(`[${new Date().toISOString()}] WebSocket: received message from ${clientAddress}: ${data}`);
            // No client-to-proxy commands are currently defined; log and ignore.
        });
    });

    wss.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] WebSocket server error: ${err.message}`);
    });
}

/**
 * Broadcasts a parsed scan object as JSON to all currently connected clients.
 * Clients that are not in OPEN state are skipped silently.
 *
 * @param {Object} scanObj  - parsed scan object from parser.js
 */
function broadcast(scanObj) {
    if (!wss) {
        console.warn(`[${new Date().toISOString()}] wsServer.broadcast called before server was started`);
        return;
    }

    const payload = JSON.stringify({ type: 'scan', ...scanObj });
    let sentCount = 0;

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload, (err) => {
                if (err) {
                    console.error(`[${new Date().toISOString()}] WebSocket: send error: ${err.message}`);
                }
            });
            sentCount++;
        }
    });

    if (sentCount > 0) {
        console.log(
            `[${new Date().toISOString()}] WebSocket: broadcast scan (gage=${scanObj.gage}) to ${sentCount} client(s)`
        );
    }
}

/**
 * Returns the number of currently connected WebSocket clients.
 * Used by restApi.js for the /health endpoint.
 *
 * @returns {number}
 */
function getClientCount() {
    if (!wss) return 0;
    let count = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) count++;
    });
    return count;
}

/**
 * Safely serializes and sends an object to a single WebSocket client.
 *
 * @param {WebSocket} ws
 * @param {Object}    obj
 */
function _sendToClient(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(obj));
    } catch (err) {
        console.error(`[${new Date().toISOString()}] wsServer._sendToClient error: ${err.message}`);
    }
}

module.exports = {
    start,
    broadcast,
    getClientCount,
};

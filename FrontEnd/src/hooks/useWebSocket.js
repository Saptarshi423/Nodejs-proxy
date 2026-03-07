import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';

/**
 * useWebSocket
 *
 * Manages a persistent WebSocket connection to the PNet4 proxy server.
 * Automatically reconnects on close or error.
 *
 * Returns:
 *   latestScan  — the most recently received scan object (type: 'scan'), or null
 *   connected   — boolean WebSocket connection state
 */
export function useWebSocket() {
    const [latestScan, setLatestScan]   = useState(null);
    const [connected, setConnected]     = useState(false);
    const wsRef                         = useRef(null);
    const reconnectTimerRef             = useRef(null);
    const stoppedRef                    = useRef(false);

    const connect = useCallback(() => {
        if (stoppedRef.current) return;

        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnected(true);
            console.log('[WS] Connected to PNet4 proxy at', WS_URL);
        };

        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                console.log(msg)
                // Only handle scan packets; ignore 'hello' and 'history' messages
                if (msg.type === 'scan') {
                    setLatestScan(msg);
                }
            } catch (e) {
                console.error('[WS] Failed to parse message:', e);
            }
        };

        ws.onclose = () => {
            setConnected(false);
            console.log('[WS] Disconnected — will retry in 3 s');
            if (!stoppedRef.current) {
                reconnectTimerRef.current = setTimeout(connect, 3000);
            }
        };

        ws.onerror = () => {
            console.warn('[WS] Connection failed — is the proxy running at', WS_URL, '?');
            ws.close();
        };
    }, []);

    useEffect(() => {
        stoppedRef.current = false;
        connect();
        return () => {
            stoppedRef.current = true;
            clearTimeout(reconnectTimerRef.current);
            wsRef.current?.close();
        };
    }, [connect]);

    return { latestScan, connected };
}

import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';

/**
 * useWebSocket
 *
 * Manages a persistent WebSocket connection to the PNet4 proxy server.
 * Automatically reconnects on close or error.
 *
 * Handles two message types:
 *   'history' — full trend history sent by the proxy on connect.
 *               Pre-populates scansByGage immediately so the chart shows
 *               without waiting for the next scan event.
 *   'scan'    — a single parsed EOS scan packet. Updates the gage entry.
 *
 * Returns:
 *   scansByGage  — { [gageNo]: latestScanObj }  (one entry per gage seen)
 *   connected    — boolean WebSocket connection state
 */
export function useWebSocket() {
    const [scansByGage, setScansByGage] = useState({});
    const [connected,   setConnected]   = useState(false);
    const wsRef             = useRef(null);
    const reconnectTimerRef = useRef(null);
    const stoppedRef        = useRef(false);

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

                if (msg.type === 'scan') {
                    // Accept any scan that has a non-empty profile array.
                    // noDataFlag is intentionally not filtered here — the chart
                    // will display the data regardless; callers can check
                    // scanObj.noDataFlag if they need to gate on it.
                    if (!msg.prf || msg.prf.length === 0) return;
                    setScansByGage(prev => ({ ...prev, [msg.gage]: msg }));
                }

                else if (msg.type === 'history') {
                    // The proxy sends the full trendStore on connect.
                    // Extract the most recent valid scan per gage so the chart
                    // populates immediately without waiting for the next scan.
                    const initial = {};
                    for (const [gageStr, scans] of Object.entries(msg.data ?? {})) {
                        if (!Array.isArray(scans) || scans.length === 0) continue;

                        // Walk backwards to find the most recent scan with a profile
                        for (let i = scans.length - 1; i >= 0; i--) {
                            const s = scans[i];
                            if (s.prf && s.prf.length > 0) {
                                initial[Number(gageStr)] = s;
                                break;
                            }
                        }
                    }
                    if (Object.keys(initial).length > 0) {
                        console.log('[WS] Pre-populated from history:', Object.keys(initial).map(g => `gage ${g}`).join(', '));
                        setScansByGage(initial);
                    }
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

    return { scansByGage, connected };
}

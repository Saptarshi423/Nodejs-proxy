import { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import ProfileChart from './components/ProfileChart';
import './App.css';

export default function App() {
    const { latestScan, connected } = useWebSocket();
    const [selectedGage, setSelectedGage] = useState(null);
    const [scansByGage,  setScansByGage]  = useState({});

    // Keep the latest valid scan per gage (ignore noDataFlag != 0)
    useEffect(() => {
        if (!latestScan) return;
        if (latestScan.noDataFlag !== 0) return;
        if (!latestScan.prf || latestScan.prf.length === 0) return;

        setScansByGage((prev) => {
            const next = { ...prev, [latestScan.gage]: latestScan };
            return next;
        });

        // Auto-select first gage seen
        setSelectedGage((prev) => (prev === null ? latestScan.gage : prev));
    }, [latestScan]);

    const availableGages = Object.keys(scansByGage).map(Number).sort();
    const currentScan    = selectedGage !== null ? scansByGage[selectedGage] : null;
    const alertsReady    = currentScan &&
        !(currentScan.hiAlert === 0 && currentScan.loAlert === 0);

    return (
        <div className="app">
            {/* ── Header ─────────────────────────────────────────────────── */}
            <header className="app-header">
                <h1>Profile Viewer</h1>
                <span className={`status-badge ${connected ? 'online' : 'offline'}`}>
                    {connected ? '● Connected' : '○ Disconnected'}
                </span>
            </header>

            {/* ── Gage tabs (only when multiple gages are present) ────────── */}
            {availableGages.length > 1 && (
                <div className="gage-selector">
                    {availableGages.map((g) => (
                        <button
                            key={g}
                            className={`gage-btn ${g === selectedGage ? 'active' : ''}`}
                            onClick={() => setSelectedGage(g)}
                        >
                            Gage {g}
                        </button>
                    ))}
                </div>
            )}

            {/* ── Main content ────────────────────────────────────────────── */}
            {currentScan ? (
                <div className="main-content">
                    {/* Stats bar */}
                    <div className="stats-bar">
                        <StatCard label="Avg"      value={currentScan.avg?.toFixed(5)} />
                        <StatCard label="Sigma"    value={currentScan.sigma?.toFixed(5)} />
                        <StatCard label="Min"      value={currentScan.min?.toFixed(5)} />
                        <StatCard label="Max"      value={currentScan.max?.toFixed(5)} />
                        <StatCard label="Hi Alert"
                                  value={alertsReady ? currentScan.hiAlert?.toFixed(4) : 'Fetching…'}
                                  accent="warn" />
                        <StatCard label="Lo Alert"
                                  value={alertsReady ? currentScan.loAlert?.toFixed(4) : 'Fetching…'}
                                  accent="danger" />
                        <StatCard label="Footage"  value={currentScan.footage?.toFixed(1)} />
                        <StatCard label="Buckets"  value={currentScan.bktCnt} />
                    </div>

                    {/* Profile chart */}
                    <div className="chart-wrapper">
                        <ProfileChart scanData={currentScan} />
                    </div>
                </div>
            ) : (
                <div className="waiting">
                    {connected
                        ? 'Waiting for scan data from device…'
                        : 'Not connected — proxy server should be running at ws://localhost:8080'}
                </div>
            )}
        </div>
    );
}

function StatCard({ label, value, accent }) {
    return (
        <div className={`stat-card ${accent ?? ''}`}>
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value ?? '—'}</span>
        </div>
    );
}

import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import ProfileChart from './components/ProfileChart';
import './App.css';

export default function App() {
    const { scansByGage, connected } = useWebSocket();
    const [selectedGage, setSelectedGage] = useState(null);

    const availableGages = Object.keys(scansByGage).map(Number).sort();

    // Auto-select the first gage seen
    const activeGage = selectedGage !== null && scansByGage[selectedGage] !== undefined
        ? selectedGage
        : (availableGages.length > 0 ? availableGages[0] : null);

    const currentScan = activeGage !== null ? scansByGage[activeGage] : null;
    const alertsReady = currentScan && (currentScan.hiAlert !== 0 || currentScan.loAlert !== 0);

    return (
        <div className="app">
            {/* ── Header ─────────────────────────────────────────────────── */}
            <header className="app-header">
                <h1>Profile Viewer</h1>
                <span className={`status-badge ${connected ? 'online' : 'offline'}`}>
                    {connected ? '● Connected' : '○ Disconnected'}
                </span>
            </header>

            {/* ── Gage tabs ───────────────────────────────────────────────── */}
            {availableGages.length > 1 && (
                <div className="gage-selector">
                    {availableGages.map((g) => (
                        <button
                            key={g}
                            className={`gage-btn ${g === activeGage ? 'active' : ''}`}
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
                        <StatCard label="Avg"    value={currentScan.avg?.toFixed(5)} />
                        <StatCard label="Sigma"  value={currentScan.sigma?.toFixed(5)} />
                        <StatCard label="Min"    value={currentScan.min?.toFixed(5)} />
                        <StatCard label="Max"    value={currentScan.max?.toFixed(5)} />
                        <StatCard label="Target"
                                  value={alertsReady ? currentScan.target?.toFixed(4) : 'Fetching…'} />
                        {/* <StatCard label="Hi Alert"
                                  value={alertsReady
                                      ? (currentScan.target + currentScan.hiAlert).toFixed(4)
                                      : 'Fetching…'}
                                  accent="warn" />
                        <StatCard label="Lo Alert"
                                  value={alertsReady
                                      ? (currentScan.target + currentScan.loAlert).toFixed(4)
                                      : 'Fetching…'}
                                  accent="danger" />
                        <StatCard label="Footage" value={currentScan.footage?.toFixed(1)} />
                        <StatCard label="Buckets" value={currentScan.bktCnt} /> */}
                        {currentScan.noDataFlag !== 0 && (
                            <StatCard label="⚠ No Data" value={`flag=${currentScan.noDataFlag}`} accent="danger" />
                        )}
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

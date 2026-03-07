import { useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    LinearScale,
    PointElement,
    LineElement,
    Filler,
    Title,
    Tooltip,
    Legend,
} from 'chart.js';

ChartJS.register(LinearScale, PointElement, LineElement, Filler, Title, Tooltip, Legend);

// ---------------------------------------------------------------------------
// Custom Chart.js plugin — draws colored background regions and alert lines.
//
// Regions (filled before the dataset is drawn):
//   • Above hiAlert  → yellow
//   • loAlert..hiAlert → green
//   • Below loAlert  → red
//
// Alert lines (drawn after the dataset, so they appear on top):
//   • hiAlert — dashed amber line with label
//   • loAlert — dashed red line with label
//
// Values are passed via chart.options.plugins.alertRegions.
// If both hiAlert and loAlert are 0 the regions are skipped (HIF not yet ready).
// ---------------------------------------------------------------------------
const alertRegionsPlugin = {
    id: 'alertRegions',

    beforeDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;

        const { left, right, top, bottom } = chartArea;
        const width  = right - left;
        const height = bottom - top;

        // ── Black background (full canvas, then chart area) ─────────────────
        ctx.save();
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.fillRect(left, top, width, height);
        ctx.restore();

        const opts = chart.options.plugins?.alertRegions ?? {};
        const { hiAlert, loAlert } = opts;
        // Skip if alerts haven't been fetched yet
        if (hiAlert === undefined || loAlert === undefined) return;
        if (hiAlert === 0 && loAlert === 0) return;

    },

    afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;

        const opts = chart.options.plugins?.alertRegions ?? {};
        const { hiAlert, loAlert } = opts;
        if (hiAlert === undefined || loAlert === undefined) return;
        if (hiAlert === 0 && loAlert === 0) return;

        const { left, right, top, bottom } = chartArea;
        const y = scales.y;

        const drawLine = (value, strokeColor, labelText) => {
            const py = y.getPixelForValue(value);
            if (py < top || py > bottom) return;

            ctx.save();
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth   = 2;
            ctx.setLineDash([8, 5]);
            ctx.beginPath();
            ctx.moveTo(left, py);
            ctx.lineTo(right, py);
            ctx.stroke();

            // Label on right edge, just above the line
            ctx.setLineDash([]);
            ctx.fillStyle    = strokeColor;
            ctx.font         = 'bold 11px system-ui, sans-serif';
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(labelText, right - 6, py - 3);
            ctx.restore();
        };

        drawLine(hiAlert, 'rgba(255, 220, 0, 1)',   `Hi Alert: ${hiAlert.toFixed(4)}`);
        drawLine(loAlert, 'rgba(255,  60, 60, 1)', `Lo Alert: ${loAlert.toFixed(4)}`);
    },
};

// Register once globally
ChartJS.register(alertRegionsPlugin);

// ---------------------------------------------------------------------------
// ProfileChart component
// ---------------------------------------------------------------------------
export default function ProfileChart({ scanData }) {
    const chartRef = useRef(null);

    const { prf, minScan, maxScan, hiAlert, loAlert, gage } = scanData;
    const n = prf.length;

    // Build {x, y} point array with x positions mapped to [minScan, maxScan]
    const points = useMemo(() => {
        const span = maxScan - minScan;
        const step = n > 1 ? span / (n - 1) : 0;
        return prf.map((val, i) => ({ x: minScan + i * step, y: val }));
    }, [prf, minScan, maxScan, n]);

    const alertsAvailable = hiAlert !== 0 || loAlert !== 0;

    // Constant reference lines used as fill targets
    const hiAlertPoints = useMemo(
        () => alertsAvailable ? points.map(p => ({ x: p.x, y: hiAlert })) : [],
        [points, hiAlert, alertsAvailable],
    );
    const loAlertPoints = useMemo(
        () => alertsAvailable ? points.map(p => ({ x: p.x, y: loAlert })) : [],
        [points, loAlert, alertsAvailable],
    );

    // Green fill source: collapses to hiAlert outside the green zone → zero-height fill there
    const greenFillPoints = useMemo(
        () => alertsAvailable
            ? points.map(p => ({
                x: p.x,
                y: (p.y >= loAlert && p.y <= hiAlert) ? p.y : hiAlert,
              }))
            : [],
        [points, hiAlert, loAlert, alertsAvailable],
    );

    // Red fill source: collapses to loAlert outside the red zone → zero-height fill there
    const redFillPoints = useMemo(
        () => alertsAvailable
            ? points.map(p => ({ x: p.x, y: p.y < loAlert ? p.y : loAlert }))
            : [],
        [points, loAlert, alertsAvailable],
    );

    const data = useMemo(() => ({
        datasets: [
            // ── Dataset 0: invisible loAlert reference line ─────────────────
            { data: loAlertPoints, borderWidth: 0, pointRadius: 0, fill: false },

            // ── Dataset 1: invisible hiAlert reference line ─────────────────
            { data: hiAlertPoints, borderWidth: 0, pointRadius: 0, fill: false },

            // ── Dataset 2: green fill — only where profile is within limits ─
            {
                data:        greenFillPoints,
                borderWidth: 0,
                pointRadius: 0,
                fill:        alertsAvailable
                    ? { target: 1, above: 'transparent', below: 'rgba(0, 180, 0, 0.45)' }
                    : false,
            },

            // ── Dataset 3: red fill — only where profile is below loAlert ───
            {
                data:        redFillPoints,
                borderWidth: 0,
                pointRadius: 0,
                fill:        alertsAvailable
                    ? { target: 0, above: 'transparent', below: 'rgba(200, 30, 30, 0.55)' }
                    : false,
            },

            // ── Dataset 4: profile line — yellow fill above hiAlert + segment color ─
            {
                label:       `Gage ${gage} Profile`,
                data:        points,
                borderWidth: 1.5,
                pointRadius: 0,
                tension:     0,
                borderColor: 'rgba(255, 255, 255, 0.9)',
                fill:        alertsAvailable
                    ? { target: 1, above: 'rgba(220, 200, 0, 0.50)', below: 'transparent' }
                    : false,
                segment: alertsAvailable ? {
                    borderColor: (ctx) => {
                        const y = ctx.p1.parsed.y;
                        if (y > hiAlert) return 'rgba(220, 200, 0, 1)';
                        if (y < loAlert) return 'rgba(200,  30, 30, 1)';
                        return 'rgba(0, 180, 0, 1)';
                    },
                } : undefined,
            },
        ],
    }), [points, gage, hiAlert, loAlert,
         hiAlertPoints, loAlertPoints, greenFillPoints, redFillPoints, alertsAvailable]);

    const options = useMemo(() => ({
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,   // disable for smooth live updates
        parsing:             false,   // data already in {x,y} form

        plugins: {
            legend: { display: false },
            title:  { display: false },
            tooltip: {
                mode: 'index',
                intersect: false,
                filter: (item) => item.datasetIndex === 4,   // only the profile
                callbacks: {
                    title:  (items) => `Position: ${items[0]?.parsed.x.toFixed(2)} mm`,
                    label:  (ctx)   => `Value: ${ctx.parsed.y.toFixed(5)}`,
                },
            },
            // Pass alert values to the custom plugin
            alertRegions: { hiAlert, loAlert },
        },

        scales: {
            x: {
                type:  'linear',
                min:   minScan,
                max:   maxScan,
                title: { display: true, text: 'Cross-Direction Position (mm)', color: '#ccc', font: { size: 12 } },
                ticks: { maxTicksLimit: 12, color: '#aaa' },
                grid:  { color: 'rgba(0, 80, 200, 0.5)' },
            },
            y: {
                type:  'linear',
                ...(hiAlert !== 0 || loAlert !== 0
                    ? { min: loAlert - 1, max: hiAlert + 1 }
                    : {}),
                title: { display: true, text: 'Measurement Value', color: '#ccc', font: { size: 12 } },
                ticks: { color: '#aaa' },
                grid:  { color: 'rgba(0, 80, 200, 0.5)' },
            },
        },
    }), [minScan, maxScan, hiAlert, loAlert]);

    return (
        <div style={{ position: 'relative', height: '100%', width: '100%' }}>
            <Line ref={chartRef} data={data} options={options} />
        </div>
    );
}

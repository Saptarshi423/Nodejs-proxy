import { useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
} from 'chart.js';

ChartJS.register(LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

// ---------------------------------------------------------------------------
// Custom plugin
//
// beforeDraw          — black background
// beforeDatasetsDraw  — colored fill between profile and alert lines (% deviation)
//                       yellow  where profile > hiPct
//                       green   where loPct ≤ profile ≤ hiPct
//                       red     where profile < loPct
// afterDraw           — dashed target (0%) + alert lines on top of everything
// ---------------------------------------------------------------------------
const profilePlugin = {
    id: 'profilePlugin',

    beforeDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        ctx.save();
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
    },

    beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y || !scales.x) return;

        const { hiPct, loPct } = chart.options.plugins?.profilePlugin ?? {};
        if (hiPct === undefined || loPct === undefined) return;
        if (hiPct === 0 && loPct === 0) return;

        const points = chart.data.datasets[0]?.data;
        if (!points || points.length < 2) return;

        const y0 = scales.y.getPixelForValue(0); // target line

        // Base clip: chart area only
        ctx.save();
        ctx.beginPath();
        ctx.rect(chartArea.left, chartArea.top,
                 chartArea.right - chartArea.left,
                 chartArea.bottom - chartArea.top);
        ctx.clip();

        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const mid = (p1.y + p2.y) / 2;

            const x1 = scales.x.getPixelForValue(p1.x);
            const x2 = scales.x.getPixelForValue(p2.x);
            const y1 = scales.y.getPixelForValue(p1.y);
            const y2 = scales.y.getPixelForValue(p2.y);

            if (mid > hiPct) {
                // ── Yellow: from profile down to target (0%) ──────────────
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x2, y0);
                ctx.lineTo(x1, y0);
                ctx.closePath();
                ctx.fillStyle = 'rgba(220, 200, 0, 0.80)';
                ctx.fill();

            } else if (mid >= loPct) {
                // ── Green: between profile and target (0%) ────────────────
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x2, y0);
                ctx.lineTo(x1, y0);
                ctx.closePath();
                ctx.fillStyle = 'rgba(0, 180, 0, 0.80)';
                ctx.fill();

            } else {
                // ── Red: from profile up to target (0%) ───────────────────
                ctx.beginPath();
                ctx.moveTo(x1, y0);
                ctx.lineTo(x2, y0);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x1, y1);
                ctx.closePath();
                ctx.fillStyle = 'rgba(200, 30, 30, 0.80)';
                ctx.fill();
            }
        }
        ctx.restore();
    },

    afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;

        const { hiPct, loPct, target } = chart.options.plugins?.profilePlugin ?? {};
        if (hiPct === undefined) return;

        const { left, right, top, bottom } = chartArea;

        const drawLine = (value, color, label) => {
            const py = scales.y.getPixelForValue(value);
            if (py < top || py > bottom) return;

            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([8, 5]);
            ctx.beginPath();
            ctx.moveTo(left,  py);
            ctx.lineTo(right, py);
            ctx.stroke();

            ctx.setLineDash([]);
            ctx.fillStyle    = color;
            ctx.font         = 'bold 11px system-ui, sans-serif';
            ctx.textAlign    = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(label, right - 6, py - 3);
            ctx.restore();
        };

        // Target is always at 0% in deviation mode; label shows the actual target value
        drawLine(0, 'rgba(255, 255, 255, 0.55)', `Target: ${target?.toFixed(4) ?? '0.0000'}`);

        if (hiPct !== 0 || loPct !== 0) {
            drawLine(hiPct, 'rgba(255, 220,  0, 1)',  `Hi: ${hiPct.toFixed(2)}`);
            drawLine(loPct, 'rgba(255,  60, 60, 1)', `Low: ${loPct.toFixed(2)}`);
        }
    },
};

ChartJS.register(profilePlugin);

// ---------------------------------------------------------------------------
// ProfileChart
// ---------------------------------------------------------------------------
export default function ProfileChart({ scanData }) {
    const chartRef = useRef(null);

    const {
        prf,
        minScan,
        maxScan,
        bktWdth,
        hiAlert,
        loAlert,
        target = 0,
        gage,
    } = scanData;

    const n    = prf.length;
    const step = bktWdth ?? (n > 1 ? (maxScan - minScan) / (n - 1) : 0);

    // hiAlert / loAlert from HIF are in % (e.g. +5.0 = +5%, -5.0 = -5%)
    const hiPct = hiAlert;
    const loPct = loAlert;
    const alertsAvailable = hiAlert !== 0 || loAlert !== 0;

    const xMin = minScan;
    const xMax = minScan + (n - 1) * step;

    // Convert profile to % deviation from target: (val - target) / target * 100
    const devPrf = useMemo(
        () => (target !== 0 ? prf.map(val => (val - target) / target * 100) : prf),
        [prf, target],
    );

    // Profile points — % deviation on Y, position on X
    const points = useMemo(
        () => devPrf.map((val, i) => ({ x: minScan + i * step, y: val })),
        [devPrf, minScan, step],
    );

    // Y-axis range: cover both alert band and actual deviation extent
    const yAxisRange = useMemo(() => {
        const prfMin = Math.min(...devPrf);
        const prfMax = Math.max(...devPrf);

        if (!alertsAvailable) {
            const range = prfMax - prfMin || 1;
            const pad   = range * 0.1;
            return { min: prfMin - pad, max: prfMax + pad };
        }

        const visMin = Math.min(loPct, prfMin);
        const visMax = Math.max(hiPct, prfMax);
        const range  = visMax - visMin || 1;
        const pad    = Math.max(range * 0.1, 0.5);
        return { min: visMin - pad, max: visMax + pad };
    }, [devPrf, alertsAvailable, hiPct, loPct]);

    // Single dataset — white profile line only (fill handled by canvas plugin)
    const data = useMemo(() => ({
        datasets: [{
            label:       `Gage ${gage}`,
            data:        points,
            borderColor: 'rgba(255, 255, 255, 0.95)',
            borderWidth: 1.5,
            pointRadius: 0,
            tension:     0,
            fill:        false,
        }],
    }), [points, gage]);

    const options = useMemo(() => ({
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        parsing:             false,

        plugins: {
            legend:  { display: false },
            title:   { display: false },
            tooltip: {
                mode:      'index',
                intersect: false,
                callbacks: {
                    //title: (items) => `Position: ${items[0]?.parsed.x.toFixed(2)} mm`,
                    //label: (ctx)   => `Deviation: ${ctx.parsed.y.toFixed(3)}%`,
                },
            },
            // Pass % values and actual target to the custom plugin
            profilePlugin: { hiPct, loPct, target },
        },

        scales: {
            x: {
                type:  'linear',
                min:   xMin,
                max:   xMax,
                title: { display: true, text: 'Cross-Direction Position (mm)', color: '#ccc', font: { size: 12 } },
                ticks: { maxTicksLimit: 12, color: '#aaa' },
                grid:  { color: 'rgba(0, 80, 200, 0.5)' },
            },
            y: {
                type:  'linear',
                ...yAxisRange,
                title: { display: true, text: 'Deviation from Target (%)', color: '#ccc', font: { size: 12 } },
                ticks: { color: '#aaa', callback: (v) => `${v.toFixed(1)}%` },
                grid:  { color: 'rgba(0, 80, 200, 0.5)' },
            },
        },
    }), [xMin, xMax, hiPct, loPct, yAxisRange]);

    return (
        <div style={{ position: 'relative', height: '100%', width: '100%' }}>
            <Line ref={chartRef} data={data} options={options} />
        </div>
    );
}

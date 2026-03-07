# PNet4 Profile Viewer

A real-time cross-direction profile viewer for NDC PNet4 gauges.
A Node.js proxy server bridges the binary TCP stream from the device to a React dashboard over WebSocket.

```
PNet4 Device  ──TCP:25000──►  Proxy Server  ──WS:8080──►  React Dashboard
               ──TCP:20000──►  (HIF alerts)  ──HTTP:3001──► (REST API)
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- Network access to the PNet4 device

---

## Project Structure

```
NodeJS Proxy/
├── Proxy/                  # Node.js proxy server
│   ├── src/
│   │   ├── index.js        # Entry point — wires everything together
│   │   ├── tcpClient.js    # Connects to device, parses binary packets
│   │   ├── hifClient.js    # Fetches hi/lo alert thresholds via HIF port
│   │   ├── wsServer.js     # WebSocket server (broadcasts scan data)
│   │   ├── restApi.js      # REST API (trend history + health)
│   │   ├── parser.js       # Binary packet parser (ProNet & non-ProNet)
│   │   └── trendStore.js   # In-memory ring buffer for trend history
│   ├── .env                # Environment configuration (see below)
│   └── package.json
│
└── FrontEnd/               # React + Vite dashboard
    ├── src/
    │   ├── App.jsx
    │   ├── components/
    │   │   └── ProfileChart.jsx
    │   └── hooks/
    │       └── useWebSocket.js
    └── package.json
```

---

## 1. Configure the Proxy

Edit `Proxy/.env` to match your device's network address:

```env
DEVICE_HOST=192.168.29.151   # IP address of the PNet4 device
DEVICE_PORT=25000            # TCP port for scan data
WS_PORT=8080                 # WebSocket port exposed to the frontend
REST_PORT=3001               # HTTP REST API port
MAX_TREND_POINTS=101         # Trend history ring buffer size per gage
RECONNECT_DELAY_MS=5000      # Reconnect interval on disconnect (ms)
```

---

## 2. Start the Proxy Server

```bash
cd Proxy

# Install dependencies (first time only)
npm install

# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

The proxy will print a startup banner confirming all ports and the target device address.

---

## 3. Start the Frontend

In a separate terminal:

```bash
cd FrontEnd

# Install dependencies (first time only)
npm install

# Development server (hot reload)
npm run dev
```

Open the URL printed by Vite (default: `http://localhost:5173`) in your browser.

To point the frontend at a proxy running on a different host, create `FrontEnd/.env.local`:

```env
VITE_WS_URL=ws://<proxy-host>:8080
```

---

## REST API

| Method   | Endpoint        | Description                          |
|----------|-----------------|--------------------------------------|
| GET      | `/health`       | Server status, device connection, WS client count |
| GET      | `/trend`        | Trend history for all gages (0–6)    |
| GET      | `/trend/:gage`  | Trend history for a specific gage    |
| DELETE   | `/trend/:gage`  | Clear trend history for a gage       |

Base URL: `http://localhost:3001`

---

## Production Build (Frontend)

```bash
cd FrontEnd
npm run build       # outputs to FrontEnd/dist/
npm run preview     # serves the built files locally to verify
```
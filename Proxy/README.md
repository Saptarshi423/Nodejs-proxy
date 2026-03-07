# PNet4 Proxy Server

A Node.js proxy that connects to an NDC Technologies **PNet4** industrial measurement device over TCP, translates its binary scan data into JSON, and serves the data to React web applications via WebSocket and REST API.

---

## What This Does

The PNet4 device broadcasts a binary scan packet (2682 bytes) over TCP port 25000 after every measurement scan. This proxy maintains a persistent TCP connection to the device, reassembles the raw byte stream into complete packets, parses the big-endian binary fields into JavaScript objects, stores a rolling history of scan results in memory, and pushes each new scan to all connected browser clients in real time over WebSocket. A REST API provides on-demand access to historical trend data and server health status.

---

## Prerequisites

- **Node.js 18+** (uses `Buffer` APIs and modern ES2020 syntax)
- The PNet4 device must be reachable over TCP from the machine running this proxy
- `npm` (included with Node.js)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Edit .env with the device's IP address
#    Open .env and set DEVICE_HOST to your PNet4 device's IP
notepad .env   # Windows
```

**.env file:**
```env
DEVICE_HOST=192.168.29.203   # <-- set this to your device's IP
DEVICE_PORT=25000
WS_PORT=8080
REST_PORT=3001
MAX_TREND_POINTS=101
RECONNECT_DELAY_MS=5000
```

---

## Running

```bash
# Production
npm start

# Development (auto-restarts on file changes, requires nodemon)
npm run dev
```

On startup you will see:

```
╔══════════════════════════════════════════════════════╗
║             PNet4 Proxy Server Started               ║
╠══════════════════════════════════════════════════════╣
║  Device     : 192.168.1.100:25000                    ║
║  WebSocket  : ws://localhost:8080                    ║
║  REST API   : http://localhost:3001                  ║
║  Trend pts  : 101 per gage                           ║
║  Reconnect  : 5000ms                                 ║
╚══════════════════════════════════════════════════════╝
```

The proxy will automatically reconnect to the device if the TCP connection drops.

---

## WebSocket Usage

### Connecting from a React app

```js
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected to PNet4 proxy');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'hello') {
    console.log('Proxy says:', msg.message);
  }

  if (msg.type === 'history') {
    // msg.data is an object keyed by gage number (0-6)
    // Each value is an array of historical scan objects
    console.log('Received history for', Object.keys(msg.data).length, 'gages');
    // Populate your charts here
  }

  if (msg.type === 'scan') {
    // msg is a live scan object — update your dashboard
    console.log(`Gage ${msg.gage}: avg=${msg.avg}, sigma=${msg.sigma}`);
  }
};

ws.onclose = () => {
  console.log('Disconnected from proxy — reconnect your app here');
};
```

### Message types received from the proxy

| Type       | When sent                              | Content |
|------------|----------------------------------------|---------|
| `hello`    | Immediately on connect                 | `{ type, message, serverTime }` |
| `history`  | Immediately on connect                 | `{ type, data: { "0": [...], "1": [...], ... } }` |
| `scan`     | After every scan from the device       | See scan object format below |

---

## REST API Endpoints

Base URL: `http://localhost:3001`

| Method | Path             | Description                                      |
|--------|------------------|--------------------------------------------------|
| GET    | `/health`        | Server health and device connection status       |
| GET    | `/trend`         | All gages' trend history                         |
| GET    | `/trend/:gage`   | Trend history for gage `0`–`6`                   |
| DELETE | `/trend/:gage`   | Clear trend history for gage `0`–`6`             |

### GET /health
```json
{
  "status": "ok",
  "connectedToDevice": true,
  "wsClients": 2,
  "uptimeSeconds": 3600,
  "serverTime": "2024-03-02T12:00:00.000Z"
}
```

### GET /trend/0
```json
{
  "status": "ok",
  "gage": 0,
  "count": 87,
  "maxPoints": 101,
  "data": [ /* array of scan objects */ ]
}
```

---

## JSON Message Format

### Scan event (type: 'scan')
```json
{
  "type": "scan",
  "gage": 0,
  "timestamp": 1709385600000,
  "dataType": 1,
  "scanDir": 1,
  "min": 1.23,
  "max": 1.45,
  "avg": 1.34,
  "sigma": 0.05,
  "minScan": 0.0,
  "maxScan": 2540.0,
  "bktWdth": 5.0,
  "secondsPerBkt": 0.1,
  "footage": 12345.6,
  "endFootage": 12400.2,
  "bktCnt": 512,
  "totalCnt": 1024,
  "overCnt": 0,
  "underCnt": 0,
  "sum": 1372.16,
  "x2sum": 1840.01,
  "strtAvg": 1.30,
  "endAvg": 1.38,
  "sheetWidth": 2540.0,
  "noDataFlag": 0
}
```

**Notes:**
- `timestamp` is Java time (milliseconds since Unix epoch). Pass directly to `new Date(timestamp)`.
- `min` / `max` are the trend minimum and maximum for this scan window (from the `mini` / `maxi` fields in the device packet).
- `sigma` is computed on the proxy: `sqrt(|x2sum / totalCnt - avg^2|)`.
- The raw 512-element profile array (`prf[]`) is intentionally excluded to keep WebSocket payloads small.

### History event (type: 'history')
```json
{
  "type": "history",
  "data": {
    "0": [ /* array of scan objects for gage 0 */ ],
    "1": [ /* array of scan objects for gage 1 */ ],
    "2": [],
    "3": [],
    "4": [],
    "5": [],
    "6": []
  }
}
```

---

## Connecting a React App

1. Start the proxy: `npm start`
2. In your React project install nothing extra — the browser's native `WebSocket` API is sufficient.
3. Point your component at `ws://localhost:8080` for live data.
4. For historical data, fetch `http://localhost:3001/trend` on component mount.
5. If the React dev server runs on a different port (e.g. 3000), CORS is already enabled on the REST API.

---

## Architecture

```
PNet4 Device (TCP :25000)
        |
        | binary scan packets (2682 bytes)
        v
   tcpClient.js          ← stream reassembly + heartbeat filtering
        |
        | emit('scan', parsedObj)
        v
    parser.js            ← big-endian binary → JS object
        |
   ┌────┴────┐
   v         v
trendStore   wsServer    ← broadcast to all WebSocket clients
   |                           (port 8080)
   v
restApi      ← GET /trend, GET /health
(port 3001)
```

## File Structure

```
NodeJS Proxy/
├── package.json         ← dependencies and scripts
├── .env                 ← configuration (device IP, ports)
├── src/
│   ├── index.js         ← entry point, wires everything together
│   ├── tcpClient.js     ← TCP connection, stream reassembly, reconnect logic
│   ├── parser.js        ← binary packet parser (big-endian)
│   ├── trendStore.js    ← in-memory ring buffer (101 points per gage)
│   ├── wsServer.js      ← WebSocket server (port 8080)
│   └── restApi.js       ← Express REST API (port 3001)
└── README.md
```

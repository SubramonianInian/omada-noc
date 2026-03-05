# Omada NOC

Real-time network operations center dashboard for TP-Link Omada SDN controllers.

![Dark Theme](https://img.shields.io/badge/theme-dark%20%2F%20light-blue)
![Docker](https://img.shields.io/badge/docker-ready-green)
![Node](https://img.shields.io/badge/node-20%2B-brightgreen)

## Features

- **Animated Network Topology** — Interactive SVG diagram with data flow particles, pulsing nodes, and spinning WAN globe
- **Live Traffic Monitoring** — Real-time download/upload chart from gateway `txRate`/`rxRate` with gradient fills and glow indicators
- **Client Breakdown** — Clients grouped by VLAN with search, WiFi/wired split, and download/upload totals
- **Device Health** — Status tiles for gateways, switches, and access points with uptime, IP, model info
- **Rotating Info Panel** — Auto-cycles through top clients, AP list, events, traffic summary, and network stats
- **Event Ticker** — Scrolling event feed at the bottom
- **Dark / Light Mode** — Toggle with persistence via localStorage
- **Fullscreen Mode** — Built for wall-mounted NOC monitors
- **30s Auto-Refresh** — With animated countdown ring

## Quick Start

```bash
npm install
node server.js
```

Open http://localhost:3737 and enter your Omada controller credentials.

## Docker

```bash
# Build
docker build -t omada-noc .

# Run
docker run -d -p 3737:3737 --name omada-noc omada-noc
```

Or use the npm scripts:

```bash
npm run docker:build
npm run docker:run
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3737` | Server port |
| `DEBUG_TRAFFIC` | (unset) | Set to `1` to log traffic polling data |

## Architecture

```
Browser  →  Express (port 3737)  →  Omada Controller API v2
                │
                ├── /api/login          → Authenticate + get CSRF token
                ├── /api/dashboard      → Clients, devices, events
                ├── /api/traffic-history → Polled gateway throughput rates
                ├── /api/alerts         → Recent events
                └── /api/health         → Health check
```

- **Backend**: Node.js + Express proxy to Omada API (bypasses self-signed SSL)
- **Frontend**: Single HTML file with inline CSS/JS (no build tools)
- **Traffic Polling**: Fetches gateway `txRate`/`rxRate` every 30s, falls back to cumulative byte deltas
- **Security**: XSS-safe via `escapeHtml()` on all dynamic content, security headers, no CORS needed

## Requirements

- Node.js 18+ (20 recommended)
- TP-Link Omada SDN Controller v5.x (API v2)
- Network access to the controller

## License

ISC

# Omada Network Dashboard

A clean, dark-themed dashboard for TP-Link Omada controllers.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Start the proxy server**
   ```bash
   node server.js
   ```

3. **Open the dashboard**
   Visit: http://localhost:3737

## Login

Enter your Omada controller details:
- **Host**: IP address of your Omada controller (e.g., `192.168.1.100`)
- **Port**: Default is `8043` (HTTPS)
- **Username/Password**: Your Omada admin credentials

## Features

- 📊 **Overview** — Live stats: clients, APs, switches, gateways
- 👥 **Clients** — All connected devices with signal strength, IP, MAC, traffic
- 📡 **Access Points** — AP status, models, client count, channels
- 🔀 **Switches** — Switch status, ports, uptime
- 🔔 **Events** — Recent network activity log
- 🔄 Auto-refreshes every 30 seconds

## Notes

- The proxy server bypasses SSL certificate warnings (self-signed certs on Omada are fine)
- Your credentials are only used locally — nothing is sent externally
- Supports Omada SDN Controller v5.x API (v2)

## Requirements

- Node.js 16+
- Omada SDN Controller (local network access)

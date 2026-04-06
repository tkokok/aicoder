# AICoder

AI-powered coding agent with control plane + data plane architecture.

## Quick Start

### 1. Install dependencies

Requires [Bun](https://bun.sh) (recommended) or Node.js.

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and set CALLBACK_TOKEN and ports as needed
```

Key variables:
- `CONTROL_PLANE_PORT` — Web UI and API port (default: 8080)
- `AGENT_PORT` — Data plane port (default: 2080)
- `CALLBACK_TOKEN` — Secret token for control/data plane communication

### 3. Start the server

```bash
./start.sh
```

Or manually:
```bash
NO_PROXY=localhost,127.0.0.1 bun dist/server/index.js
```

## Access

- **Control Plane**: http://localhost:8080
- **Data Plane**: http://localhost:2080

## Notes

- The SQLite database (`aicoder.db`) is created automatically on first startup.
- `better-sqlite3` may compile native bindings during `bun install`; ensure Python 3 and a C++ compiler are available.

#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "========================================"
    echo "Created .env from .env.example"
    echo "Please edit .env and set CALLBACK_TOKEN"
    echo "========================================"
    exit 1
  else
    echo "Error: .env.example not found"
    exit 1
  fi
fi

export NO_PROXY=localhost,127.0.0.1

# Load .env exports
set -a
source .env
set +a

echo "Starting AICoder..."
echo "Control Plane: http://localhost:${CONTROL_PLANE_PORT:-8080}"
echo "Data Plane:    http://localhost:${AGENT_PORT:-2080}"

exec bun dist/server/index.js

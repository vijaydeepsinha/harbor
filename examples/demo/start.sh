#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

export UVICORN_PORT="${UVICORN_PORT:-3005}"

echo "=== MCP Demo: Product + Order + Task + IRCTC services ==="
echo ""

# Kill any leftover processes on demo ports
for PORT in 3001 3002 3003 "$UVICORN_PORT"; do
  PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Killing existing process on port $PORT (pid $PID)"
    kill "$PID" 2>/dev/null || true
  fi
done

# Start mock backend services
echo "Starting product-service on :3001 ..."
node "$SCRIPT_DIR/product-service.js" &
PRODUCT_PID=$!

echo "Starting order-service on :3002 ..."
node "$SCRIPT_DIR/order-service.js" &
ORDER_PID=$!

echo "Starting task-service on :3003 ..."
node "$SCRIPT_DIR/task-service.js" &
TASK_PID=$!

echo "Starting irctc-service on :$UVICORN_PORT ..."
(cd "$SCRIPT_DIR/irctc" && exec "$SCRIPT_DIR/irctc/.venv/bin/python3" -m app.main) &
IRCTC_PID=$!

# Give them a moment to bind
sleep 0.5

echo ""
echo "Starting Harbor on :3333 ..."
echo "  Bearer token for client: configure a JWT or a >=32-char opaque token in your MCP client"
echo ""

cd "$ROOT"
nvm use 22 --silent 2>/dev/null || true
npm run dev &
MCP_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$PRODUCT_PID" "$ORDER_PID" "$TASK_PID" "$IRCTC_PID" "$MCP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== All services running ==="
echo "  product-service : http://localhost:3001"
echo "  order-service   : http://localhost:3002"
echo "  task-service    : http://localhost:3003"
echo "  irctc-service   : http://localhost:$UVICORN_PORT"
echo "  Harbor          : http://localhost:3333/mcp"
echo ""
echo "Connect your MCP client to http://localhost:3333/mcp"
echo "Press Ctrl+C to stop all services."
echo ""

wait "$MCP_PID"

#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Contributors to the Harbor project.
#
# Starts Harbor in OAuth mode: the Docker mock AS, the billing backend, the
# mock RFC 7662 introspection server, and Harbor itself wired up so all three
# non-static auth strategies (oauth-2.1, jwt-validation, oauth-introspection)
# are live and reachable — matching the setup tests/demo_e2e.py's Phase 2
# automates, and what postman/Harbor.postman_collection.json's OAuth-mode
# folders expect. See postman/README.md for the full manual testing guide.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."

echo "=== Harbor OAuth mode: billing (oauth-2.1) + billing-jwt (jwt-validation) + billing-introspection (oauth-introspection) ==="
echo ""

# Kill any leftover processes on the ports this mode uses
for PORT in 3004 3008 3333; do
  PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Killing existing process on port $PORT (pid $PID)"
    kill "$PID" 2>/dev/null || true
  fi
done

echo "Switching service configs: billing/billing-jwt/billing-introspection=enabled, product/order/tasks=disabled ..."
python3 - "$ROOT" <<'PYEOF'
import json, sys
root = sys.argv[1]
for svc, enabled in [("billing", True), ("billing-jwt", True), ("billing-introspection", True),
                     ("product", False), ("order", False), ("tasks", False)]:
    path = f"{root}/services/{svc}/config.json"
    cfg = json.load(open(path))
    cfg["enabled"] = enabled
    json.dump(cfg, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")
PYEOF

echo "Starting Docker mock AS (navikt/mock-oauth2-server) on :8080 ..."
docker compose -f "$ROOT/examples/07-oauth/docker-compose.yml" up -d
for i in $(seq 1 30); do
  if curl -sf "http://localhost:8080/default/.well-known/openid-configuration" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Starting billing-service on :3004 ..."
node "$SCRIPT_DIR/billing-service.js" &
BILLING_PID=$!

echo "Starting mock-introspection-server on :3008 ..."
node "$SCRIPT_DIR/mock-introspection-server.js" &
INTROSPECT_PID=$!

sleep 0.5

echo ""
echo "Starting Harbor on :3333 (OAuth mode) ..."
cd "$ROOT"
nvm use 22 --silent 2>/dev/null || true
HARBOR_RESOURCE_URI="http://127.0.0.1:3333" \
HARBOR_AUTH_SERVERS="http://localhost:8080/default" \
HARBOR_SCOPES_SUPPORTED="api:read,api:write" \
npm run dev &
MCP_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BILLING_PID" "$INTROSPECT_PID" "$MCP_PID" 2>/dev/null || true
  docker compose -f "$ROOT/examples/07-oauth/docker-compose.yml" down >/dev/null 2>&1 || true
  echo "Restoring service configs: product/order/tasks=enabled, billing/billing-jwt/billing-introspection=disabled ..."
  python3 - "$ROOT" <<'PYEOF'
import json, sys
root = sys.argv[1]
for svc, enabled in [("billing", False), ("billing-jwt", False), ("billing-introspection", False),
                     ("product", True), ("order", True), ("tasks", True)]:
    path = f"{root}/services/{svc}/config.json"
    cfg = json.load(open(path))
    cfg["enabled"] = enabled
    json.dump(cfg, open(path, "w"), indent=2, ensure_ascii=False)
    open(path, "a").write("\n")
PYEOF
}
trap cleanup EXIT INT TERM

echo ""
echo "=== OAuth mode running ==="
echo "  Docker mock AS            : http://localhost:8080/default"
echo "  billing-service           : http://localhost:3004"
echo "  mock-introspection-server : http://localhost:3008"
echo "  Harbor                    : http://localhost:3333/mcp"
echo ""
echo "Get a real JWT: curl -u harbor-test-client:test-secret -d grant_type=client_credentials http://localhost:8080/default/token"
echo "Run the Postman collection's 'Auth — oauth-2.1 / jwt-validation / oauth-introspection' folders against this now."
echo "Press Ctrl+C to stop and restore default (static-token) mode."
echo ""

wait "$MCP_PID"

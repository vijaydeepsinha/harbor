#!/usr/bin/env python3
"""
End-to-end smoke test for the Harbor demo.

Exercises the full Cursor workflow shown in cursor_available_services_inquiry.md:
  discover_services → discover_skills → search_code → api_execute
  across all three demo services: product, order, tasks.

Usage:
  # Start demo services first, then run:
  python3 tests/demo_e2e.py

  # Or let the script start everything itself:
  python3 tests/demo_e2e.py --start-services

  # Include OAuth 2.1 tests (requires Harbor running with HARBOR_RESOURCE_URI set):
  python3 tests/demo_e2e.py --start-services --oauth \
    --oauth-resource-uri "http://127.0.0.1:3333" \
    --oauth-auth-servers "https://auth.example.com"

  # Full suite — MCP tools + OAuth metadata + real JWT via Docker mock AS:
  python3 tests/demo_e2e.py --start-services --oauth \
    --oauth-resource-uri "http://127.0.0.1:3333" \
    --oauth-auth-servers "https://auth.example.com" \
    --docker-oauth

Phase 1 (--start-services [--oauth]):
  Starts product/order/tasks backend services and Harbor, exercises all MCP tools,
  optionally verifies the OAuth 2.1 metadata endpoints with a synthetic auth-server URL.

Phase 2 (--docker-oauth):
  Spins up a Docker mock OAuth 2.1 AS (navikt/mock-oauth2-server on :8080),
  switches Harbor to OAuth mode, acquires a real JWT via client_credentials,
  and verifies Harbor accepts it through full JWT validation (JWKS fetch + signature check).
  Restores token mode and tears down Docker on exit.
  Skipped with a warning if Docker is not available.

Requires: Python 3.9+, stdlib only (no external packages).
Phase 1 services run on localhost:3001 (product), 3002 (order), 3003 (task), 3333 (Harbor).
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import base64
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

# ── Config ────────────────────────────────────────────────────────────────────

GATEWAY_BASE  = "http://127.0.0.1:3333"
GATEWAY_URL   = f"{GATEWAY_BASE}/mcp"
BEARER_TOKEN  = "TestBearerTokenForE2ETestingOnly"
MCP_PROTOCOL  = "2026-07-28"
MCP_META_PROTOCOL   = "io.modelcontextprotocol/protocolVersion"
MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
MCP_META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities"
SERVICE_STARTUP_WAIT_S = 1

OAUTH_AS_BASE      = "http://localhost:8080/default"
OAUTH_CLIENT_ID    = "harbor-test-client"
OAUTH_CLIENT_SECRET = "test-secret"

ROOT         = Path(__file__).parent.parent
COMPOSE_FILE = ROOT / "examples" / "07-oauth" / "docker-compose.yml"

# ── Colour helpers ────────────────────────────────────────────────────────────

GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
BOLD   = "\033[1m"
RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}✓{RESET} {msg}")
def fail(msg): print(f"  {RED}✗{RESET} {msg}")
def info(msg): print(f"  {CYAN}·{RESET} {msg}")
def section(title): print(f"\n{BOLD}{CYAN}── {title}{RESET}")

# ── Process management ────────────────────────────────────────────────────────

_procs: list[subprocess.Popen] = []
_oauth_harbor_proc: Optional[subprocess.Popen] = None

def _find_node() -> str:
    for candidate in [
        os.path.expanduser("~/.nvm/versions/node/v22.22.1/bin/node"),
        "node",
    ]:
        try:
            subprocess.run([candidate, "--version"], capture_output=True, check=True)
            return candidate
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    sys.exit(f"{RED}node not found — install Node 22+{RESET}")

def start_services(extra_env: Optional[dict] = None):
    node = _find_node()
    demo = ROOT / "examples" / "demo"
    env = {**os.environ, "NODE_PATH": str(ROOT / "node_modules"), **(extra_env or {})}

    for script, port in [
        ("product-service.js", 3001),
        ("order-service.js",   3002),
        ("task-service.js",    3003),
    ]:
        proc = subprocess.Popen(
            [node, str(demo / script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            cwd=str(ROOT),
            start_new_session=True,
        )
        _procs.append(proc)
        info(f"Started {script} (pid {proc.pid})")

    time.sleep(SERVICE_STARTUP_WAIT_S)

    tsx = ROOT / "node_modules" / ".bin" / "tsx"
    gw = subprocess.Popen(
        [node, str(tsx), "index.ts"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**env, "LOG_LEVEL": "error"},
        cwd=str(ROOT),
        start_new_session=True,
    )
    _procs.append(gw)
    info(f"Started Harbor gateway (pid {gw.pid})")

    # Poll until ready instead of blind sleep
    for _ in range(20):
        try:
            urllib.request.urlopen(f"{GATEWAY_BASE}/health", timeout=1)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("Harbor gateway did not become ready")

def stop_services():
    for p in _procs:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception:
            pass
    for p in _procs:
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                p.wait(timeout=1)
            except Exception:
                pass

# ── Docker / OAuth helpers ────────────────────────────────────────────────────

def _docker_available() -> bool:
    try:
        subprocess.run(["docker", "info"], capture_output=True, check=True, timeout=5)
        return True
    except Exception:
        return False

def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) != 0

def _docker_oauth_up():
    if not _port_free(8080):
        raise RuntimeError(
            "Port 8080 is already in use. "
            "Stop whatever is using it before running --docker-oauth."
        )
    subprocess.run(
        ["docker", "compose", "-f", str(COMPOSE_FILE), "up", "-d"],
        check=True,
        cwd=str(ROOT),
        capture_output=True,
    )
    info("Waiting for Docker mock AS on :8080...")
    for _ in range(30):
        try:
            urllib.request.urlopen(
                f"{OAUTH_AS_BASE}/.well-known/openid-configuration", timeout=2
            )
            info("Docker mock AS ready.")
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Docker OAuth server did not become ready within 30s")

def _docker_oauth_down():
    try:
        subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE_FILE), "down"],
            capture_output=True,
            timeout=30,
        )
        info("Docker OAuth server stopped.")
    except Exception:
        pass

def _set_service_enabled(name: str, enabled: bool):
    cfg_path = ROOT / "services" / name / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["enabled"] = enabled
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")

def _switch_to_oauth_mode():
    _set_service_enabled("billing", True)
    for svc in ("product", "order", "tasks"):
        _set_service_enabled(svc, False)
    info("Service mode: billing=enabled, product/order/tasks=disabled")

def _switch_to_token_mode():
    _set_service_enabled("billing", False)
    for svc in ("product", "order", "tasks"):
        _set_service_enabled(svc, True)
    info("Service mode restored: product/order/tasks=enabled, billing=disabled")

def _start_harbor_oauth(oauth_env: dict):
    global _oauth_harbor_proc
    node = _find_node()
    tsx  = ROOT / "node_modules" / ".bin" / "tsx"
    env  = {
        **os.environ,
        "NODE_PATH":    str(ROOT / "node_modules"),
        "SERVICES_DIR": str(ROOT / "services"),
        "LOG_LEVEL":    "error",
        **oauth_env,
    }
    _oauth_harbor_proc = subprocess.Popen(
        [node, str(tsx), "index.ts"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
        cwd=str(ROOT),
        start_new_session=True,
    )
    info(f"Started Harbor in OAuth mode (pid {_oauth_harbor_proc.pid})")
    for _ in range(20):
        try:
            urllib.request.urlopen(f"{GATEWAY_BASE}/health", timeout=1)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("Harbor (OAuth mode) did not become ready")

def _stop_harbor_oauth():
    global _oauth_harbor_proc
    if _oauth_harbor_proc is None:
        return
    try:
        os.killpg(os.getpgid(_oauth_harbor_proc.pid), signal.SIGTERM)
    except Exception:
        pass
    try:
        _oauth_harbor_proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(_oauth_harbor_proc.pid), signal.SIGKILL)
        except Exception:
            pass
    _oauth_harbor_proc = None
    info("Harbor (OAuth mode) stopped")

def _get_real_jwt() -> str:
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    credentials = base64.b64encode(f"{OAUTH_CLIENT_ID}:{OAUTH_CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        f"{OAUTH_AS_BASE}/token",
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {credentials}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())["access_token"]

def _mcp_envelope() -> dict:
    return {
        MCP_META_PROTOCOL: MCP_PROTOCOL,
        MCP_META_CLIENT_INFO: {"name": "e2e-smoke", "version": "1"},
        MCP_META_CLIENT_CAPS: {},
    }

def _mcp_params(params: dict) -> dict:
    return {**params, "_meta": _mcp_envelope()}

def _mcp_headers(method: str, token: str, name: Optional[str] = None) -> dict:
    headers = {
        "Content-Type":           "application/json",
        "Authorization":          f"Bearer {token}",
        "Accept":                 "application/json, text/event-stream",
        "MCP-Protocol-Version":   MCP_PROTOCOL,
        "Mcp-Method":             method,
    }
    if name is not None:
        headers["Mcp-Name"] = name
    return headers

def _parse_mcp_response(raw: str) -> dict:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    for line in raw.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return {"_transport_error": f"unparseable response: {raw[:200]}"}

def _mcp_discover_with_jwt(jwt: str) -> dict:
    """Returns parsed server/discover response, or {_error: ...} on failure."""
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "server/discover",
        "params": _mcp_params({}),
    }
    req = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(payload).encode(),
        headers=_mcp_headers("server/discover", jwt),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return _parse_mcp_response(resp.read().decode())
    except Exception as e:
        return {"_error": str(e)}

def _mcp_post_jwt(payload: dict, jwt: str, mcp_name: Optional[str] = None) -> dict:
    """POST an MCP request using a JWT (2026-07-28 envelope + headers)."""
    method = payload["method"]
    body_payload = dict(payload)
    if "params" in body_payload and isinstance(body_payload["params"], dict):
        body_payload["params"] = _mcp_params(body_payload["params"])
    req = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(body_payload).encode(),
        headers=_mcp_headers(method, jwt, mcp_name),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return _parse_mcp_response(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_error": f"HTTP {e.code}: {e.read().decode()[:200]}"}

def _post_with_bearer(path: str, token: str) -> tuple[int, dict]:
    """POST to path with an explicit Bearer token; returns (status, headers)."""
    url = f"{GATEWAY_BASE}{path}"
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "server/discover",
        "params": _mcp_params({}),
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers=_mcp_headers("server/discover", token),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}

# ── MCP transport helpers ─────────────────────────────────────────────────────

def _mcp_post(payload: dict, token: str = BEARER_TOKEN) -> dict:
    method = payload["method"]
    mcp_name = None
    params = payload.get("params") or {}
    if method == "tools/call":
        mcp_name = params.get("name")
    body_payload = dict(payload)
    if "params" in body_payload and isinstance(body_payload["params"], dict):
        body_payload["params"] = _mcp_params(body_payload["params"])

    req = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(body_payload).encode(),
        headers=_mcp_headers(method, token, mcp_name),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return _parse_mcp_response(resp.read().decode())
    except Exception as e:
        return {"_transport_error": str(e)}

def mcp_init() -> bool:
    payload = {
        "jsonrpc": "2.0", "id": 0, "method": "server/discover",
        "params": {},
    }
    try:
        resp = _mcp_post(payload)
    except Exception as e:
        print(f"{RED}Gateway not reachable: {e}{RESET}")
        return False

    if "_transport_error" in resp:
        print(f"{RED}Gateway not reachable: {resp['_transport_error']}{RESET}")
        return False
    if "error" in resp:
        print(f"{RED}server/discover failed: {resp['error']}{RESET}")
        return False
    server_info = resp.get("result", {}).get("serverInfo", {})
    return server_info.get("name") == "harbor"

def call_tool(name: str, args: dict, req_id: int) -> dict:
    resp = _mcp_post({
        "jsonrpc": "2.0", "id": req_id, "method": "tools/call",
        "params": {"name": name, "arguments": args},
    })
    if "_transport_error" in resp:
        return {"_error": resp["_transport_error"]}
    if "error" in resp:
        return {"_error": resp["error"].get("message", str(resp["error"]))}
    try:
        text = resp["result"]["content"][0]["text"]
        return json.loads(text)
    except Exception as e:
        return {"_error": f"parse failed: {e}", "_raw": resp}

def api_exec(service: str, code: str, req_id: int) -> dict:
    return call_tool("api_execute", {"service": service, "code": code}, req_id)

# ── Assertions ────────────────────────────────────────────────────────────────

_passed = 0
_failed = 0

def assert_true(condition: bool, label: str):
    global _passed, _failed
    if condition:
        _passed += 1
        ok(label)
    else:
        _failed += 1
        fail(label)

def assert_eq(actual, expected, label: str):
    if actual != expected:
        assert_true(False, f"{label}  (expected {expected!r}, got {actual!r})")
    else:
        assert_true(True, label)

def assert_in(item, container, label: str):
    assert_true(item in container, label)

def assert_no_error(d: dict, label: str) -> bool:
    global _passed, _failed
    if "_error" in d:
        _failed += 1
        fail(f"{label}  →  {d['_error'][:120]}")
        return False
    _passed += 1
    ok(label)
    return True

# ── HTTP helpers (used by OAuth tests) ───────────────────────────────────────

def _get(url: str) -> tuple[int, dict, dict]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
            headers = {k.lower(): v for k, v in resp.headers.items()}
            try:
                return resp.status, headers, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, headers, {}
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in e.headers.items()}
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = {}
        return e.code, headers, body

def _post_no_token(path: str) -> tuple[int, dict]:
    url = f"{GATEWAY_BASE}{path}"
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}

# ── Test cases ────────────────────────────────────────────────────────────────

def test_discover_services():
    section("discover_services")
    result = call_tool("discover_services", {}, 100)
    if not assert_no_error(result, "call succeeded"):
        return

    services = {s["service"]: s for s in result} if isinstance(result, list) else {}
    assert_in("order",   services, "order service present")
    assert_in("product", services, "product service present")
    assert_in("tasks",   services, "tasks service present")

    for name in ("order", "product", "tasks"):
        if name in services:
            assert_true(
                bool(services[name].get("description")),
                f"{name} has a description",
            )

def test_discover_skills():
    section("discover_skills")
    for service in ("product", "order", "tasks"):
        result = call_tool(
            "discover_skills",
            {"service": service, "code": "async () => skills"},
            200,
        )
        if "_error" not in result:
            count = len(result) if isinstance(result, list) else 0
            assert_true(count >= 1, f"{service}: at least 1 skill returned (got {count})")
        else:
            fail(f"{service}: discover_skills failed — {result['_error'][:80]}")

def test_product_service():
    section("api_execute → product service")

    r = api_exec("product",
        'async () => { const r = await api.request({ method: "GET", path: "/products" }); return r.data; }',
        300)
    if assert_no_error(r, "GET /products succeeded"):
        products = r.get("products", [])
        assert_eq(len(products), 4, "4 products returned")
        ids = [p["id"] for p in products]
        for pid in ("p001", "p002", "p003", "p004"):
            assert_in(pid, ids, f"product {pid} present")

    r = api_exec("product",
        'async () => { const r = await api.request({ method: "GET", path: "/products", params: { category: "electronics" } }); return r.data; }',
        301)
    if assert_no_error(r, "GET /products?category=electronics succeeded"):
        cats = [p["category"] for p in r.get("products", [])]
        assert_true(all(c == "electronics" for c in cats), "all results are electronics")

    r = api_exec("product",
        'async () => { const r = await api.request({ method: "GET", path: "/products/p001" }); return r.data; }',
        302)
    if assert_no_error(r, "GET /products/p001 succeeded"):
        assert_eq(r.get("id"), "p001",                "id is p001")
        assert_eq(r.get("name"), "Wireless Headphones", "name correct")
        assert_eq(r.get("inStock"), True,              "in stock")

    r = api_exec("product",
        'async () => { const r = await api.request({ method: "GET", path: "/products/p999" }); return { status: r.status, ok: r.ok }; }',
        303)
    if assert_no_error(r, "GET /products/p999 returns 404"):
        assert_eq(r.get("status"), 404, "status is 404")

def test_order_service():
    section("api_execute → order service")

    r = api_exec("order",
        'async () => { const r = await api.request({ method: "POST", path: "/orders", body: { productId: "p001", quantity: 1 } }); return r.data; }',
        400)
    order_id = None
    if assert_no_error(r, "POST /orders succeeded"):
        order_id = r.get("orderId")
        assert_true(bool(order_id),                   "orderId present")
        assert_eq(r.get("productId"), "p001",          "productId correct")
        assert_eq(r.get("quantity"),  1,               "quantity correct")
        assert_eq(r.get("status"),    "confirmed",     "status confirmed")
        assert_true(bool(r.get("estimatedDelivery")), "estimatedDelivery present")

    if order_id:
        r = api_exec("order",
            f'async () => {{ const r = await api.request({{ method: "GET", path: "/orders/{order_id}" }}); return r.data; }}',
            401)
        if assert_no_error(r, f"GET /orders/{order_id} succeeded"):
            assert_eq(r.get("orderId"),   order_id,    "orderId matches")
            assert_eq(r.get("status"),    "confirmed", "status confirmed")
            assert_eq(r.get("productId"), "p001",      "productId matches")

    r = api_exec("order",
        'async () => { const r = await api.request({ method: "POST", path: "/orders", body: { productId: "p001" } }); return { status: r.status, ok: r.ok }; }',
        402)
    if assert_no_error(r, "POST /orders missing quantity returns 400"):
        assert_eq(r.get("status"), 400, "status is 400")

    r = api_exec("order",
        'async () => { const r = await api.request({ method: "GET", path: "/orders/ord-9999" }); return { status: r.status, ok: r.ok }; }',
        403)
    if assert_no_error(r, "GET /orders/ord-9999 returns 404"):
        assert_eq(r.get("status"), 404, "status is 404")

def test_task_service():
    section("api_execute → task service")

    r = api_exec("tasks",
        'async () => { const r = await api.request({ method: "GET", path: "/api/v1/tasks" }); return r.data; }',
        500)
    initial_count = 0
    if assert_no_error(r, "GET /api/v1/tasks succeeded"):
        initial_count = r.get("total", 0)
        assert_true(initial_count >= 4, f"at least 4 seeded tasks (got {initial_count})")

    r = api_exec("tasks",
        'async () => { const r = await api.request({ method: "POST", path: "/api/v1/tasks", body: { title: "Submit paper on 20 June", priority: "medium" } }); return r.data; }',
        501)
    task_id = None
    if assert_no_error(r, "POST /api/v1/tasks succeeded"):
        task_id = r.get("id")
        assert_true(bool(task_id),                         "id present")
        assert_eq(r.get("title"),    "Submit paper on 20 June", "title correct")
        assert_eq(r.get("status"),   "todo",               "status defaults to todo")
        assert_eq(r.get("priority"), "medium",             "priority medium")

    if task_id:
        r = api_exec("tasks",
            f'async () => {{ const r = await api.request({{ method: "GET", path: "/api/v1/tasks/{task_id}" }}); return r.data; }}',
            502)
        if assert_no_error(r, f"GET /api/v1/tasks/{task_id} succeeded"):
            assert_eq(r.get("id"), task_id, "id matches")

    r = api_exec("tasks",
        'async () => { const r = await api.request({ method: "GET", path: "/api/v1/tasks", params: { status: "todo" } }); return r.data; }',
        503)
    if assert_no_error(r, "GET /api/v1/tasks?status=todo succeeded"):
        statuses = [t["status"] for t in r.get("tasks", [])]
        assert_true(all(s == "todo" for s in statuses), "all returned tasks are todo")
        if task_id:
            ids = [t["id"] for t in r.get("tasks", [])]
            assert_in(task_id, ids, f"newly created task {task_id} in todo list")

    if task_id:
        r = api_exec("tasks",
            f'async () => {{ const r = await api.request({{ method: "PATCH", path: "/api/v1/tasks/{task_id}", body: {{ status: "in_progress" }} }}); return r.data; }}',
            504)
        if assert_no_error(r, f"PATCH /api/v1/tasks/{task_id} to in_progress succeeded"):
            assert_eq(r.get("status"), "in_progress", "status updated")

    if task_id:
        r = api_exec("tasks",
            f'async () => {{ const r = await api.request({{ method: "PATCH", path: "/api/v1/tasks/{task_id}", body: {{ status: "flying" }} }}); return {{ status: r.status }}; }}',
            505)
        if assert_no_error(r, "PATCH with invalid status returns 400"):
            assert_eq(r.get("status"), 400, "status is 400")

    if task_id:
        r = api_exec("tasks",
            f'async () => {{ const r = await api.request({{ method: "DELETE", path: "/api/v1/tasks/{task_id}" }}); return {{ status: r.status, ok: r.ok }}; }}',
            506)
        if assert_no_error(r, f"DELETE /api/v1/tasks/{task_id} succeeded"):
            assert_eq(r.get("status"), 204, "status 204")
            assert_eq(r.get("ok"),     True, "ok true")

        r = api_exec("tasks",
            f'async () => {{ const r = await api.request({{ method: "GET", path: "/api/v1/tasks/{task_id}" }}); return {{ status: r.status }}; }}',
            507)
        if assert_no_error(r, "GET deleted task returns 404"):
            assert_eq(r.get("status"), 404, "status 404 after delete")

    r = api_exec("tasks",
        'async () => { const r = await api.request({ method: "GET", path: "/api/v1/tasks" }); return r.data; }',
        508)
    if assert_no_error(r, "GET /api/v1/tasks final count correct"):
        assert_eq(r.get("total"), initial_count, f"total back to {initial_count} after delete")

# ── OAuth 2.1 tests — metadata + backward compat (fake AS URL) ───────────────

def test_oauth_metadata(resource_uri: str):
    section("OAuth 2.1 — RFC 9728 Protected Resource Metadata")

    status, _, body = _get(f"{GATEWAY_BASE}/.well-known/oauth-protected-resource")
    assert_eq(status, 200, "GET /.well-known/oauth-protected-resource → 200")
    assert_eq(body.get("resource"), resource_uri, "resource matches HARBOR_RESOURCE_URI")
    assert_true(isinstance(body.get("authorization_servers"), list),
                "authorization_servers is a list")
    assert_true(len(body.get("authorization_servers", [])) >= 1,
                "at least one authorization_server present")
    assert_eq(body.get("bearer_methods_supported"), ["header"],
              "bearer_methods_supported = ['header']")

    status2, _, body2 = _get(f"{GATEWAY_BASE}/mcp/.well-known/oauth-protected-resource")
    assert_eq(status2, 200, "GET /mcp/.well-known/oauth-protected-resource → 200")
    assert_eq(body2.get("resource"), resource_uri,
              "/mcp sub-path returns same resource value")

    status3, headers3 = _post_no_token("/mcp")
    assert_eq(status3, 401, "POST /mcp without token → 401")
    www_auth = headers3.get("www-authenticate", "")
    assert_true(bool(www_auth), "WWW-Authenticate header is present")
    assert_true("Bearer" in www_auth, "WWW-Authenticate starts with Bearer scheme")
    assert_true("resource_metadata=" in www_auth,
                "WWW-Authenticate contains resource_metadata parameter")
    expected_metadata_url = f"{resource_uri}/.well-known/oauth-protected-resource"
    assert_true(expected_metadata_url in www_auth,
                f"WWW-Authenticate points at {expected_metadata_url}")

    section("OAuth 2.1 — backward compatibility (existing bearer still accepted)")
    status4, _, body4 = _get(f"{GATEWAY_BASE}/health")
    assert_eq(body4.get("status"), "ok", "health still ok after OAuth config active")
    assert_true(isinstance(body4.get("services"), list),
                "health still returns services list after OAuth config active")

# ── OAuth 2.1 tests — real JWT via Docker mock AS ─────────────────────────────

def test_docker_oauth(resource_uri: str):
    section("OAuth 2.1 — Real JWT (Docker mock AS on :8080)")

    # ── JWT acquisition ───────────────────────────────────────────────────────
    try:
        jwt = _get_real_jwt()
    except Exception as e:
        assert_true(False, f"JWT acquired from mock AS  →  {e}")
        return
    assert_true(bool(jwt), "JWT acquired from mock AS")
    assert_eq(len(jwt.split(".")), 3, "JWT has three dot-separated segments")

    # ── RFC 9728 discovery document (root path) ───────────────────────────────
    status, _, disc = _get(f"{GATEWAY_BASE}/.well-known/oauth-protected-resource")
    assert_eq(status, 200, "discovery → 200")
    assert_eq(disc.get("resource"), resource_uri,
              "discovery → resource matches HARBOR_RESOURCE_URI")
    assert_eq(disc.get("authorization_servers"), [OAUTH_AS_BASE],
              "discovery → authorization_servers = [mock AS]")
    assert_eq(disc.get("bearer_methods_supported"), ["header"],
              "discovery → bearer_methods_supported = ['header']")
    for scope in ("api:read", "api:write"):
        assert_in(scope, disc.get("scopes_supported", []),
                  f"discovery → scope '{scope}' in scopes_supported")

    # ── RFC 9728 discovery document (MCP sub-path) ────────────────────────────
    status2, _, disc2 = _get(f"{GATEWAY_BASE}/mcp/.well-known/oauth-protected-resource")
    assert_eq(status2, 200, "/mcp/.well-known/oauth-protected-resource → 200")
    assert_eq(disc2.get("resource"), resource_uri,
              "/mcp sub-path → resource matches HARBOR_RESOURCE_URI")

    # ── No-token → 401 + WWW-Authenticate ────────────────────────────────────
    status3, headers3 = _post_no_token("/mcp")
    assert_eq(status3, 401, "POST /mcp without token → 401")
    www_auth = headers3.get("www-authenticate", "")
    assert_true(bool(www_auth), "WWW-Authenticate header present")
    assert_true("resource_metadata=" in www_auth,
                "WWW-Authenticate contains resource_metadata=")
    expected_metadata_url = f"{resource_uri}/.well-known/oauth-protected-resource"
    assert_true(expected_metadata_url in www_auth,
                f"WWW-Authenticate points at {expected_metadata_url}")

    # ── Invalid / weak token rejected ────────────────────────────────────────
    bad_status, _ = _post_with_bearer("/mcp", "this-is-not-a-valid-jwt-token")
    assert_eq(bad_status, 401, "weak token rejected with 401")

    # ── MCP handshake with real JWT (2026-07-28) ───────────────────────────────
    section("OAuth 2.1 — MCP server/discover with real JWT")
    discover_resp = _mcp_discover_with_jwt(jwt)
    assert_true("result" in discover_resp,
                f"server/discover with real JWT → result present  {discover_resp.get('_error', '')}")
    assert_eq(
        discover_resp.get("result", {}).get("serverInfo", {}).get("name"),
        "harbor",
        "server/discover → serverInfo.name = harbor",
    )

    tools_resp = _mcp_post_jwt(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        jwt,
    )
    assert_true("_error" not in tools_resp,
                f"tools/list → no error  {tools_resp.get('_error', '')}")
    tools = tools_resp.get("result", {}).get("tools", [])
    assert_true(len(tools) > 0, f"tools/list → {len(tools)} tools returned")
    tool_names = [t["name"] for t in tools]
    for name in ("discover_services", "discover_skills", "search_code", "api_execute"):
        assert_in(name, tool_names, f"tool '{name}' present")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Harbor E2E smoke test")
    parser.add_argument(
        "--start-services", action="store_true",
        help="Start demo backend services and Harbor gateway before running tests",
    )
    parser.add_argument(
        "--oauth", action="store_true",
        help="Run OAuth 2.1 metadata tests (RFC 9728). Harbor must run with HARBOR_RESOURCE_URI set.",
    )
    parser.add_argument(
        "--oauth-resource-uri", default="http://127.0.0.1:3333", metavar="URI",
        help="Value of HARBOR_RESOURCE_URI (default: http://127.0.0.1:3333)",
    )
    parser.add_argument(
        "--oauth-auth-servers", default="https://auth.example.com", metavar="URLS",
        help="HARBOR_AUTH_SERVERS value for --start-services + --oauth",
    )
    parser.add_argument(
        "--docker-oauth", action="store_true",
        help=(
            "Run real JWT tests using a Docker mock AS (navikt/mock-oauth2-server on :8080). "
            "Switches Harbor to OAuth mode, acquires a real JWT, verifies full JWT validation. "
            "Skipped with a warning if Docker is not available."
        ),
    )
    args = parser.parse_args()

    print(f"\n{BOLD}Harbor E2E Smoke Test{RESET}")
    print("=" * 50)

    # ── Phase 1: MCP tools + fake-URL OAuth metadata ──────────────────────────
    if args.start_services:
        section("Starting phase-1 services")
        extra: dict = {}
        if args.oauth:
            extra["HARBOR_RESOURCE_URI"] = args.oauth_resource_uri
            extra["HARBOR_AUTH_SERVERS"] = args.oauth_auth_servers
            info(f"HARBOR_RESOURCE_URI={args.oauth_resource_uri}")
        start_services(extra_env=extra or None)

    section("Connecting to Harbor gateway")
    if not mcp_init():
        print(f"\n{RED}Could not connect to Harbor gateway at {GATEWAY_URL}{RESET}")
        if not args.start_services:
            print("Run with --start-services, or start the demo manually first.")
        sys.exit(1)
    ok("Gateway connected (MCP 2026-07-28)")

    try:
        test_discover_services()
        test_discover_skills()
        test_product_service()
        test_order_service()
        test_task_service()
        if args.oauth:
            test_oauth_metadata(args.oauth_resource_uri)
    finally:
        if args.start_services:
            section("Stopping phase-1 services")
            stop_services()
            info("Phase-1 processes terminated")

    # ── Phase 2: Real JWT via Docker mock AS ──────────────────────────────────
    if args.docker_oauth:
        section("Phase 2: OAuth 2.1 — Real JWT (Docker)")
        if not _docker_available():
            info(f"{YELLOW}Docker not available — skipping real JWT tests{RESET}")
        else:
            _switch_to_oauth_mode()
            _docker_oauth_up()
            try:
                _start_harbor_oauth({
                    "HARBOR_RESOURCE_URI":    args.oauth_resource_uri,
                    "HARBOR_AUTH_SERVERS":    OAUTH_AS_BASE,
                    "HARBOR_SCOPES_SUPPORTED": "api:read,api:write",
                })
                test_docker_oauth(args.oauth_resource_uri)
            finally:
                _stop_harbor_oauth()
                _docker_oauth_down()
                _switch_to_token_mode()
                info("Phase-2 cleanup complete")

    # ── Summary ───────────────────────────────────────────────────────────────
    total = _passed + _failed
    print(f"\n{'=' * 50}")
    if _failed == 0:
        print(f"{BOLD}{GREEN}All {total} assertions passed{RESET}")
    else:
        print(f"{BOLD}{RED}{_failed} failed{RESET}, {_passed} passed out of {total}")
    print()

    sys.exit(0 if _failed == 0 else 1)


if __name__ == "__main__":
    main()

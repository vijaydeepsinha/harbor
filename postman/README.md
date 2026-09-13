# Testing Harbor with Postman

`Harbor.postman_collection.json` exercises Harbor's `/mcp` endpoint across all
4 pluggable auth strategies (`static-token`, `oauth-2.1`, `jwt-validation`,
`oauth-introspection`), including negative/rejection cases for each. Every
request has `pm.test()` assertions — you don't have to eyeball responses.

Harbor only runs **one auth mode at a time** (governed by which
`services/*/config.json` entries have `"enabled": true`), so the collection
is split into two groups of folders that need two different server states:

| Folder(s) | Server mode | Start with |
|---|---|---|
| `Health & Discovery`, `Auth — static-token` | default (product/order/tasks) | `examples/demo/start.sh` |
| `Auth — oauth-2.1`, `Auth — jwt-validation`, `Auth — oauth-introspection` | OAuth mode (billing/billing-jwt/billing-introspection) | `examples/demo/start-oauth-mode.sh` |

You do not need to hand-edit any config files or manage Docker/process
lifecycles yourself — both scripts do it for you, including restoring the
default state on `Ctrl+C`.

## Prerequisites

- Node 22+, `npm install` already run at the repo root.
- Docker running (only needed for the OAuth-mode script — it starts
  `navikt/mock-oauth2-server` via `examples/07-oauth/docker-compose.yml`).
- [Postman](https://www.postman.com/downloads/) (GUI) and/or
  [newman](https://www.npmjs.com/package/newman) (CLI) — `npx newman` works
  without a separate install.

## 1. Static-token mode

```bash
bash examples/demo/start.sh
```
Leave this running in a terminal (it prints its own status and blocks on
`Ctrl+C` to stop). In Postman (or via newman), run:
- `Health & Discovery`
- `Auth — static-token (product/order/tasks)`

```bash
# CLI equivalent
npx newman run postman/Harbor.postman_collection.json \
  --folder "Health & Discovery" \
  --folder "Auth — static-token (product/order/tasks)"
```

`Ctrl+C` the script when done — it kills product/order/task and Harbor.

## 2. OAuth mode (oauth-2.1 / jwt-validation / oauth-introspection)

```bash
bash examples/demo/start-oauth-mode.sh
```
This script:
1. Flips `services/billing`, `services/billing-jwt`, `services/billing-introspection` to `enabled: true` and `services/product`/`order`/`tasks` to `false`.
2. Starts the Docker mock OAuth server (`docker compose -f examples/07-oauth/docker-compose.yml up -d`).
3. Starts `examples/demo/billing-service.js` (:3004) and `examples/demo/mock-introspection-server.js` (:3008) — the two backends all three OAuth-mode folders call.
4. Starts Harbor with `HARBOR_RESOURCE_URI`/`HARBOR_AUTH_SERVERS` set.

Leave it running, then in Postman (or newman) run:
- `Auth — oauth-2.1 (billing)`
- `Auth — jwt-validation (billing-jwt)`
- `Auth — oauth-introspection (billing-introspection)`

```bash
# CLI equivalent
npx newman run postman/Harbor.postman_collection.json \
  --folder "Auth — oauth-2.1 (billing)" \
  --folder "Auth — jwt-validation (billing-jwt)" \
  --folder "Auth — oauth-introspection (billing-introspection)"
```

**Important — run order inside the `oauth-2.1` and `jwt-validation` folders:**
each folder's first two requests, `Setup — get correct-audience JWT` and
`Setup — get wrong-audience JWT (confused-deputy)`, mint real JWTs from the
mock AS and store them into the collection variables `jwtCorrect`/
`jwtWrongAud` that every request below them uses. Running a folder
top-to-bottom (via the Postman Runner, or newman, or manually one-by-one in
order) does this automatically — but if you jump straight to e.g. the
"correct-aud JWT → success" request without running the Setup requests
first in that same session, it'll use whatever stale value (or the empty
default) is currently in those variables.

`introspection` uses fixed, hardcoded test tokens instead (see
`examples/demo/mock-introspection-server.js`), so it needs no setup step.

`Ctrl+C` the script when done — it kills all three processes, tears down the
Docker container, and restores `services/*/config.json` back to default
(static-token) mode.

## Using the Postman GUI instead of newman

1. Import `postman/Harbor.postman_collection.json` (File → Import). All
   variables (`baseUrl`, `oauthAsBase`, tokens, etc.) are already baked into
   the collection — no separate environment file needed.
2. Start the matching server (see above).
3. Right-click a folder → **Run folder** (this runs its requests in order,
   which matters for the Setup requests described above) — or just click
   through requests top-to-bottom manually.
4. Check the **Test Results** tab on each request/run for pass/fail.

## This collection is a manual testing tool — deliberately not run in CI

Harbor's CI (`.github/workflows/ci.yml`) does **not** run this collection or
depend on `newman` in any way — not even ephemerally via `npx`. This was a
deliberate call, not an oversight: `newman`'s own dependency tree pulls in
old `faker`/`handlebars`/`flatted`/`csv-parse` versions carrying several
high-severity CVEs and one critical (a Handlebars template-injection RCE).
For an open-source project, keeping the CI/build dependency surface as small
and auditable as possible matters more than automating this one collection —
so it stays a manual, human-run tool, and `newman` never appears in
`package.json`, `package-lock.json`, or any workflow step.

The same coverage this collection gives you by hand is already automated,
dependency-free, on every commit via `tests/demo_e2e.py` (see
`.github/workflows/ci.yml`'s "E2E" step) and the Vitest unit/integration
suite — those exercise the identical request/response contracts for all 4
auth strategies without needing `newman` at all. This collection exists
purely as an additional, optional way for a human to poke at a running
Harbor instance from Postman — run it whenever you want extra confidence
during manual testing, not as a required gate.

## If something fails

- **Connection refused** — the matching script isn't running, or hasn't
  finished starting yet (OAuth mode takes a few seconds for Docker + Harbor
  to come up).
- **401 on a request that should succeed** — you're probably running the
  wrong folder against the wrong server mode (e.g. `Auth — oauth-2.1`
  against a `start.sh`-started server, which has `billing` disabled).
- **`isError: true` on a "success" request in the oauth-2.1/jwt-validation
  folders** — re-run the two `Setup` requests first; `jwtCorrect`/
  `jwtWrongAud` may be stale or empty.
- Full command-level equivalents of everything these scripts do are in
  `tests/demo_e2e.py`'s `_switch_to_oauth_mode()` / `_start_harbor_oauth()`
  / `_start_introspection_server()` if you need to debug a step manually.

# Testing Harbor with Postman

Two collections live here:

| Collection | Covers | Environment |
|---|---|---|
| `mcp-governance.postman_collection.json` + `environments/local.postman_environment.json` | the Code Mode governance lifecycle — allow / deny / approval-required, MRTR approve + resume, the HTTP fallback approval, a multi-step workflow with two approvals, denial, replay, idempotency, error cases, security, audit, review hardening (15 folders, 118 requests, 224 assertions). Generated from the vitest E2E fixtures by `npm run postman:build`. | `npm run governance:up` (Docker) or `npm run governance:up -- --local`; run with `npm run test:postman`, `npx newman`, or the Postman GUI (folders top to bottom — they chain ids through collection variables). Runs in CI (`governance-e2e.yml`) through the dependency-free runner `tests/postman/run-collection.mjs`, see [`TESTING.md`](../TESTING.md). |
| `Harbor.postman_collection.json` | the four auth strategies (below) | `examples/demo/start.sh` / `start-oauth-mode.sh` — manual only |

Folder `15 - Review Hardening` of the governance collection replays the corner
cases fixed in the 2026-09-27 review of main, each with assertions on the tool
result and on what reached the mock backend: an equivalent spelling of a denied
`DELETE` (`/%6frders/…`) is still denied by `deny-delete-order`; dot-segment,
encoded-slash and absolute-URL paths are refused with `INVALID_API_REQUEST` and
nothing is sent; program-supplied `Authorization`, method-override and
idempotency headers are dropped (the backend sees the caller and Harbor's own
key); a body passed as a JSON string is governed like the object; an accept
without a boolean `approve` (no content, or the string `"false"`) is refused
over MRTR and HTTP (400) and the approval stays pending; a conflicting MRTR decline after an HTTP approve gets
`APPROVAL_ALREADY_DECIDED` and runs nothing; a POST that gets a 500 is sent
once; an uncaught backend timeout is `SANDBOX_RUNTIME`, not retryable; and two
fresh submissions of one create carry different idempotency keys. It mirrors
`tests/e2e/governance/bypass.test.ts`, `approval.test.ts`, `failures.test.ts`
and `idempotency.test.ts`; like every folder it is built by
`tests/postman/build-collection.mts` — edit that, not the JSON.

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

## `Harbor.postman_collection.json` is a manual testing tool — deliberately not run in CI

Harbor's CI (`.github/workflows/ci.yml`) does **not** run this collection or
depend on `newman` in any way — not even ephemerally via `npx`. This was a
deliberate call, not an oversight: `newman`'s own dependency tree pulls in
old `faker`/`handlebars`/`flatted`/`csv-parse` versions carrying several
high-severity CVEs and one critical (a Handlebars template-injection RCE).
For an open-source project, keeping the CI/build dependency surface as small
and auditable as possible matters more than automating this one collection —
so it stays a manual, human-run tool, and `newman` never appears in
`package.json`, `package-lock.json`, or any workflow step. The governance
collection above respects the same rule: CI runs it through the small
dependency-free runner in `tests/postman/run-collection.mjs`, and
`POSTMAN_RUNNER=newman npm run test:postman` is available for humans who
want the real thing via `npx`.

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
- **`{{bearer_token_...}}` "value is not initialised", or a request that
  should send `Bearer not-a-real-token` instead comes back with
  `MISSING_TOKEN` / `malformed_scheme`** — every level of this collection
  (root, every folder, every request) has its Authorization tab explicitly
  set to **No Auth**, precisely so nothing overrides the literal
  `Authorization` header each request already sets in its Headers tab. If
  you still see this, your Postman *workspace* has local, previously-synced
  auth state on top of the file (Postman stores per-item UI edits separately
  from the imported JSON) — re-check the Authorization tab at the request,
  its parent folder, and the collection root, and set any that aren't
  already "No Auth" back to it.

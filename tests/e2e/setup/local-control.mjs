// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** Lifecycle hook for local-process mode: `node local-control.mjs restart|kill|start` → the local stack's control server. */
const action = process.argv[2]
const url = process.env['E2E_LOCAL_CONTROL_URL'] ?? 'http://127.0.0.1:4099'
if (!['restart', 'kill', 'start'].includes(action)) {
    console.error('usage: local-control.mjs restart|kill|start');
    process.exit(2)
}
const res = await fetch(`${url}/${action}`, {method: 'POST', signal: AbortSignal.timeout(60_000)})
const body = await res.text()
if (!res.ok) {
    console.error(`local stack ${action} failed: HTTP ${res.status} ${body}`);
    process.exit(1)
}
console.log(body)

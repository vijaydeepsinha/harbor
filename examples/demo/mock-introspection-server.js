#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
//
// Minimal RFC 7662 token-introspection endpoint for the oauth-introspection E2E.
// Serves a small, fixed set of known test tokens on :3008 — this is a stub for
// a real authorization server's introspection endpoint, not a real one. Harbor
// calls this (GET/POST /introspect) before ever calling the billing backend;
// this server has no knowledge of the billing backend itself.
import http from 'http'

// Fixed, non-secret test fixtures — known to demo_e2e.py and the Postman collection.
const TOKENS = {
  'introspection-valid-token-abc123': {
    active: true,
    expires_in: 3600,
    aud: 'http://localhost:3333',
    scope: 'api:read api:write',
    sub: 'harbor-test-client'
  },
  'introspection-wrong-aud-token-xyz789': {
    active: true,
    expires_in: 3600,
    aud: 'https://not-harbor.example.com',
    scope: 'confused-deputy',
    sub: 'harbor-test-client'
  }
  // Any token not listed above (e.g. 'introspection-revoked-token-00000000' —
  // deliberately >=32 chars so Harbor's bearer-format pre-check lets it
  // through to actually reach this server) is treated as revoked/unknown:
  // RFC 7662 §2.2's `{ "active": false }` shape.
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function introspect(token) {
  return TOKENS[token] ?? { active: false }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname !== '/introspect') {
    send(res, 404, { error: 'Not found' })
    return
  }

  if (req.method === 'GET') {
    send(res, 200, introspect(url.searchParams.get('token') ?? ''))
    return
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const params = new URLSearchParams(body)
      send(res, 200, introspect(params.get('token') ?? url.searchParams.get('token') ?? ''))
    })
    return
  }

  send(res, 405, { error: 'Method not allowed' })
})

server.on('error', (err) => {
  console.error(`[mock-introspection-server] server error: ${err.message}`)
  process.exit(1)
})

const PORT = 3008
server.listen(PORT, () => console.log(`[mock-introspection-server] running on http://localhost:${PORT}`))

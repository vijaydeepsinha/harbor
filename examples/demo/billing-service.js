#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.
//
// Minimal billing backend for the OAuth 2.1 E2E. Serves the two endpoints in
// services/billing/spec.yaml on :3004. The backend itself does NOT check auth —
// Harbor validates the client's JWT (issuer, signature via JWKS, and audience /
// resource binding) *before* ever calling this backend. A request only reaches
// here after Harbor's oauth-2.1 strategy has accepted the token.
import http from 'http'

const INVOICES = [
  { id: 'inv-001', customerId: 'cust-1', amount: 120.5, currency: 'USD', status: 'issued', dueDate: '2026-09-01' },
  { id: 'inv-002', customerId: 'cust-2', amount: 89.0, currency: 'USD', status: 'paid', dueDate: '2026-08-15' }
]

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'GET' && path === '/invoices') {
    send(res, 200, { invoices: INVOICES, total: INVOICES.length })
    return
  }

  const match = path.match(/^\/invoices\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const invoice = INVOICES.find((i) => i.id === match[1])
    if (!invoice) {
      send(res, 404, { error: 'Invoice not found' })
      return
    }
    send(res, 200, invoice)
    return
  }

  send(res, 404, { error: 'Not found' })
})

server.on('error', (err) => {
  console.error(`[billing-service] server error: ${err.message}`)
  process.exit(1)
})

const PORT = 3004
server.listen(PORT, () => console.log(`[billing-service] running on http://localhost:${PORT}`))

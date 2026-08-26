// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IncomingHttpHeaders } from 'node:http'

/**
 * Normalized MCP request identity read from the 2026-07-28 HTTP headers
 * (spec §13/§14): `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`.
 *
 * These headers exist so infrastructure (Harbor is itself a gateway) can route
 * and authorize a request WITHOUT parsing the JSON-RPC body. The MCP SDK owns
 * their validation and reconciliation against the JSON-RPC request and rejects
 * inconsistent/malformed requests — Harbor does not duplicate that logic. This
 * view is advisory: for logging, routing, and authorization surface only.
 *
 * SECURITY: like all client-supplied metadata (spec §19), these values MUST NOT
 * drive authentication. They may inform coarse routing/authorization decisions,
 * but the authenticated bearer token remains the source of truth for identity.
 */
export interface McpRequestIdentity {
  protocolVersion?: string
  method?: string
  name?: string
}

/** First header value (Node lower-cases header names; some may be arrays). */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** Reads the normalized MCP request identity from inbound HTTP headers. */
export function readMcpRequestIdentity(headers: IncomingHttpHeaders): McpRequestIdentity {
  const identity: McpRequestIdentity = {}
  const pv = firstHeader(headers['mcp-protocol-version'])
  if (pv) identity.protocolVersion = pv
  const method = firstHeader(headers['mcp-method'])
  if (method) identity.method = method
  const name = firstHeader(headers['mcp-name'])
  if (name) identity.name = name
  return identity
}

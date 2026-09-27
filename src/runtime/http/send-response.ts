// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ServerResponse } from 'node:http'
import { CONTENT_TYPE_JSON } from '../../core/constants.js'

/**
 * Writes a JSON-encoded response with the correct Content-Type header.
 * Use this for every non-streaming response the gateway emits so that
 * success and error envelopes stay consistent.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': CONTENT_TYPE_JSON, ...(headers ?? {}) })
  res.end(JSON.stringify(body))
}

/**
 * Standard error envelope for the gateway's own HTTP surface (non-MCP paths).
 *
 * `code` is a stable machine-readable identifier callers can switch on;
 * `error` is a human-readable message safe to surface in UIs. Bearer-auth
 * failures add a `reason` field via a separate serializer — kept out of
 * the generic helper so the common envelope stays minimal.
 */
export function sendGatewayError(
  res: ServerResponse,
  status: number,
  code: string,
  error: string
): void {
  sendJson(res, status, { error, code })
}

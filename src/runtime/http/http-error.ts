// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Typed exception thrown by pre-auth short-circuits in the HTTP gateway.
 *
 * The top-level `createServer` handler is the only site that writes an HTTP
 * response for a non-MCP error. Lower layers (session resume, new-session
 * auth, 404 routing) throw an `HttpError` and let the funnel translate it
 * into JSON + log at the right severity.
 *
 * Fields:
 *  - `status` — HTTP status code (4xx for client errors, 5xx for server).
 *  - `code` — stable machine-readable identifier (see `ERR` constants).
 *  - `body` — optional extra fields merged into the response envelope
 *    (e.g. bearer-failure responses carry a `reason` enum).
 *  - `logContext` — structured fields to include in the server-side log
 *    entry, kept separate from `body` so we can log request metadata
 *    without leaking it to clients.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: Record<string, unknown>,
    public readonly logContext?: Record<string, unknown>,
    public readonly headers?: Record<string, string>
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

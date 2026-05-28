// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IncomingMessage } from 'node:http'
import {
  parseBearerAuthorizationHeader,
  BearerParseFailure,
  type BearerTokenParseFailureReason
} from './bearer-header-parser.js'
import {
  AuthError,
  MissingTokenError,
  TokenInvalidError
} from '../../core/types/auth.types.js'

/**
 * Outcome of extracting a bearer token from an `Authorization` header.
 *
 * On failure, callers receive:
 *  - `error` — a typed `AuthError` suitable for throwing on the MCP code path
 *    (already carries a human-readable message + `context`).
 *  - `reason` — the raw `BearerTokenParseFailureReason` for transport-level
 *    serialization (e.g. HTTP responses that expose a machine-readable code).
 *
 * Keeping `reason` as a separate field (instead of threading it through the
 * error) lets the MCP error message stay user-facing while HTTP clients still
 * get a stable enum value to switch on.
 */
export type BearerExtractionResult =
  | { ok: true; token: string }
  | { ok: false; error: AuthError; reason: BearerTokenParseFailureReason }

/**
 * Parses an `Authorization` header value into a token or a typed `AuthError`.
 *
 * This is the single place where `parseBearerAuthorizationHeader` results are
 * mapped to domain errors — both `AuthMiddleware` (MCP path) and the HTTP
 * gateway delegate to this function, so a new failure reason only needs to
 * be wired in here.
 */
export function extractBearerFromHeader(
  authorization: string | string[] | undefined
): BearerExtractionResult {
  const parsed = parseBearerAuthorizationHeader(authorization)
  if (parsed.ok) return { ok: true, token: parsed.token }

  const context = missingTokenContext(parsed.reason)
  const error = isBearerCredentialFormatFailure(parsed.reason)
    ? new TokenInvalidError(context)
    : new MissingTokenError(context)

  return { ok: false, error, reason: parsed.reason }
}

/** Convenience wrapper that reads the `Authorization` header off a Node request. */
export function extractBearerFromRequest(req: IncomingMessage): BearerExtractionResult {
  return extractBearerFromHeader(req.headers['authorization'])
}

/** Serialized HTTP 401 body produced from a bearer-authorization failure. */
export interface BearerHttpErrorResponse {
  status: 401
  body: {
    error: string
    code: string
    reason: BearerTokenParseFailureReason
  }
  headers?: Record<string, string>
}

export function bearerFailureToHttpResponse(
  error: AuthError,
  reason: BearerTokenParseFailureReason,
  resourceMetadataUrl?: string
): BearerHttpErrorResponse {
  const headers: Record<string, string> | undefined = resourceMetadataUrl
    ? { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }
    : undefined

  return {
    status: 401,
    body: { error: error.message, code: error.code, reason },
    ...(headers ? { headers } : {})
  }
}

const MISSING_TOKEN_CONTEXT: Partial<Record<BearerTokenParseFailureReason, string>> = {
  [BearerParseFailure.MissingHeader]: 'header absent',
  [BearerParseFailure.DuplicateHeader]: 'duplicate Authorization header',
  [BearerParseFailure.MalformedScheme]: 'malformed Bearer scheme',
  [BearerParseFailure.EmptyCredentials]: 'empty bearer credentials',
  [BearerParseFailure.WeakCredentials]: 'token must be a JWT (header.payload.sig) or a high-entropy opaque token (>=32 base64url chars)'
}

function missingTokenContext(reason: BearerTokenParseFailureReason): string {
  return MISSING_TOKEN_CONTEXT[reason] ?? reason
}

function isBearerCredentialFormatFailure(reason: BearerTokenParseFailureReason): boolean {
  return reason === BearerParseFailure.CredentialsTooLong
    || reason === BearerParseFailure.InvalidCredentials
    || reason === BearerParseFailure.WeakCredentials
}

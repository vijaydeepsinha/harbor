// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { decodeProtectedHeader } from 'jose'
import {
  BEARER_CREDENTIAL_MAX_OCTETS,
  REGEXP_BEARER_AUTHORIZATION_FIELD_VALUE,
  REGEXP_BEARER_CREDENTIAL_CONTROLS,
  REGEXP_OPAQUE_TOKEN_STRONG
} from '../../core/constants.js'

export const BearerParseFailure = {
  MissingHeader: 'missing_header',
  DuplicateHeader: 'duplicate_authorization_header',
  MalformedScheme: 'malformed_scheme',
  EmptyCredentials: 'empty_credentials',
  CredentialsTooLong: 'credentials_too_long',
  InvalidCredentials: 'invalid_credentials',
  WeakCredentials: 'weak_credentials'
} as const

export type BearerTokenParseFailureReason =
  (typeof BearerParseFailure)[keyof typeof BearerParseFailure]

type ParseFailure = { ok: false; reason: BearerTokenParseFailureReason }
type ParseSuccess = { ok: true; token: string }
export type BearerTokenParseResult = ParseSuccess | ParseFailure

const fail = (reason: BearerTokenParseFailureReason): ParseFailure => ({ ok: false, reason })

/**
 * Parses and syntactically validates `Authorization: Bearer <token>` per RFC 6750 shape:
 * case-insensitive `Bearer`, one or more separator bytes, then a single token with no
 * linear whitespace (JWTs and base64url opaque tokens are accepted). Tokens that are
 * neither a valid JWT (verified via jose.decodeProtectedHeader) nor a high-entropy opaque
 * token (≥ 32 base64url chars) fail with WeakCredentials.
 *
 * This does not prove the token is accepted by your auth server — only that it is safe
 * to treat as one bearer credential in the header.
 */
export function parseBearerAuthorizationHeader(
  authorization: string | string[] | undefined
): BearerTokenParseResult {
  const single = coerceToSingleHeaderValue(authorization)
  if (!single.ok) return single

  const trimmed = single.value.trim()
  if (trimmed === '') return fail(BearerParseFailure.MissingHeader)

  return parseBearerAuthorizationFieldValue(trimmed)
}

type SingleHeaderValue = { ok: true; value: string } | ParseFailure

/**
 * Collapses the `string | string[] | undefined` shape a Node HTTP header can take into
 * exactly one raw (un-trimmed) string, or a failure reason when the header is absent
 * or duplicated. Emptiness is handled by the caller after trimming.
 */
function coerceToSingleHeaderValue(authorization: string | string[] | undefined): SingleHeaderValue {
  if (authorization === undefined) return fail(BearerParseFailure.MissingHeader)
  if (!Array.isArray(authorization)) return { ok: true, value: authorization }

  if (authorization.length === 0) return fail(BearerParseFailure.MissingHeader)
  if (authorization.length > 1) return fail(BearerParseFailure.DuplicateHeader)

  const only = authorization[0]
  if (only === undefined) return fail(BearerParseFailure.MissingHeader)
  return { ok: true, value: only }
}

/** Parses a trimmed `Authorization` header value (the full `Bearer <token>` string). */
function parseBearerAuthorizationFieldValue(trimmed: string): BearerTokenParseResult {
  const match = trimmed.match(REGEXP_BEARER_AUTHORIZATION_FIELD_VALUE)
  if (!match) return fail(BearerParseFailure.MalformedScheme)

  const token = match[1]
  if (token === undefined || token.length === 0) return fail(BearerParseFailure.EmptyCredentials)

  if (token.length > BEARER_CREDENTIAL_MAX_OCTETS) return fail(BearerParseFailure.CredentialsTooLong)
  if (REGEXP_BEARER_CREDENTIAL_CONTROLS.test(token)) return fail(BearerParseFailure.InvalidCredentials)
  if (!isJwtStructure(token) && !REGEXP_OPAQUE_TOKEN_STRONG.test(token)) {
    return fail(BearerParseFailure.WeakCredentials)
  }

  return { ok: true, token }
}

/** Returns true if token decodes as a structurally valid JWT header (RFC 7519 via jose). */
function isJwtStructure(token: string): boolean {
  try {
    decodeProtectedHeader(token)
    return true
  } catch {
    return false
  }
}

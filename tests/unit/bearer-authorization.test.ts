// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  extractBearerFromHeader,
  extractBearerFromRequest,
  bearerFailureToHttpResponse
} from '../../spi/auth/bearer-authorization.js'
import {
  MissingTokenError,
  TokenInvalidError
} from '../../core/types/auth.types.js'
import { ERR, BEARER_CREDENTIAL_MAX_OCTETS } from '../../core/constants.js'

describe('extractBearerFromHeader', () => {
  it('returns ok with token on a valid Bearer header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = extractBearerFromHeader(`Bearer ${jwt}`)
    expect(r).toEqual({ ok: true, token: jwt })
  })

  it('maps missing header to MissingTokenError with "header absent" context', () => {
    const r = extractBearerFromHeader(undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(MissingTokenError)
    expect(r.error.code).toBe(ERR.MISSING_TOKEN)
    expect(r.error.context).toBe('header absent')
    expect(r.reason).toBe('missing_header')
  })

  it('maps duplicate header to MissingTokenError with duplicate context', () => {
    const r = extractBearerFromHeader(['Bearer a', 'Bearer b'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(MissingTokenError)
    expect(r.error.context).toBe('duplicate Authorization header')
    expect(r.reason).toBe('duplicate_authorization_header')
  })

  it('maps malformed scheme to MissingTokenError with descriptive context', () => {
    const r = extractBearerFromHeader('Basic xyz')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(MissingTokenError)
    expect(r.error.context).toBe('malformed Bearer scheme')
    expect(r.reason).toBe('malformed_scheme')
  })

  it('maps credentials-too-long to TokenInvalidError', () => {
    const huge = 'a'.repeat(BEARER_CREDENTIAL_MAX_OCTETS + 1)
    const r = extractBearerFromHeader(`Bearer ${huge}`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(TokenInvalidError)
    expect(r.error.code).toBe(ERR.TOKEN_INVALID)
    expect(r.reason).toBe('credentials_too_long')
  })

  it('maps invalid-credentials (control chars) to TokenInvalidError', () => {
    const r = extractBearerFromHeader('Bearer bad\x01tok')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(TokenInvalidError)
    expect(r.reason).toBe('invalid_credentials')
  })

  it('maps weak credentials to TokenInvalidError with weak_credentials reason', () => {
    const r = extractBearerFromHeader('Bearer demo-token-123')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(TokenInvalidError)
    expect(r.error.code).toBe(ERR.TOKEN_INVALID)
    expect(r.reason).toBe('weak_credentials')
  })
})

describe('extractBearerFromRequest', () => {
  it('reads the `authorization` header off a Node IncomingMessage', () => {
    const token = 'TestBearerTokenForE2ETestingOnly'
    const fakeReq = { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage
    expect(extractBearerFromRequest(fakeReq)).toEqual({ ok: true, token })
  })

  it('surfaces failure when the header is absent', () => {
    const fakeReq = { headers: {} } as unknown as IncomingMessage
    const r = extractBearerFromRequest(fakeReq)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('missing_header')
  })
})

describe('bearerFailureToHttpResponse', () => {
  it('serializes a missing-token failure to a 401 JSON envelope', () => {
    const r = extractBearerFromHeader(undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return

    const http = bearerFailureToHttpResponse(r.error, r.reason)
    expect(http.status).toBe(401)
    expect(http.body.code).toBe(ERR.MISSING_TOKEN)
    expect(http.body.reason).toBe('missing_header')
    // Message is the AuthError's user-facing string.
    expect(http.body.error).toContain('Authorization')
  })

  it('serializes a format-failure as TOKEN_INVALID with the raw reason code', () => {
    const huge = 'a'.repeat(BEARER_CREDENTIAL_MAX_OCTETS + 1)
    const r = extractBearerFromHeader(`Bearer ${huge}`)
    expect(r.ok).toBe(false)
    if (r.ok) return

    const http = bearerFailureToHttpResponse(r.error, r.reason)
    expect(http.status).toBe(401)
    expect(http.body.code).toBe(ERR.TOKEN_INVALID)
    expect(http.body.reason).toBe('credentials_too_long')
  })

  it('serializes a weak-credentials failure as TOKEN_INVALID with weak_credentials reason', () => {
    const r = extractBearerFromHeader('Bearer demo-token-123')
    expect(r.ok).toBe(false)
    if (r.ok) return

    const http = bearerFailureToHttpResponse(r.error, r.reason)
    expect(http.status).toBe(401)
    expect(http.body.code).toBe(ERR.TOKEN_INVALID)
    expect(http.body.reason).toBe('weak_credentials')
  })

  it('includes WWW-Authenticate header when resourceMetadataUrl is provided', () => {
    const r = extractBearerFromHeader(undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return

    const url = 'https://harbor.example.com/.well-known/oauth-protected-resource'
    const http = bearerFailureToHttpResponse(r.error, r.reason, url)
    expect(http.headers).toBeDefined()
    expect(http.headers!['WWW-Authenticate']).toBe(`Bearer resource_metadata="${url}"`)
  })

  it('omits headers when resourceMetadataUrl is not provided', () => {
    const r = extractBearerFromHeader(undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return

    const http = bearerFailureToHttpResponse(r.error, r.reason)
    expect(http.headers).toBeUndefined()
  })

  it('WWW-Authenticate format is exact RFC 9728 shape regardless of failure reason', () => {
    const huge = 'a'.repeat(BEARER_CREDENTIAL_MAX_OCTETS + 1)
    const r = extractBearerFromHeader(`Bearer ${huge}`)
    expect(r.ok).toBe(false)
    if (r.ok) return

    const url = 'https://harbor.example.com/.well-known/oauth-protected-resource'
    const http = bearerFailureToHttpResponse(r.error, r.reason, url)
    expect(http.headers!['WWW-Authenticate']).toBe(`Bearer resource_metadata="${url}"`)
  })
})

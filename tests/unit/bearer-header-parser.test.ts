// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { parseBearerAuthorizationHeader } from '../../spi/auth/bearer-header-parser.js'
import { BEARER_CREDENTIAL_MAX_OCTETS, BEARER_OPAQUE_MIN_OCTETS } from '../../core/constants.js'

describe('parseBearerAuthorizationHeader', () => {
  it('accepts Bearer with JWT-shaped token', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const r = parseBearerAuthorizationHeader(`Bearer ${token}`)
    expect(r).toEqual({ ok: true, token })
  })

  it('accepts case-insensitive scheme', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.e30.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = parseBearerAuthorizationHeader(`bearer ${token}`)
    expect(r).toEqual({ ok: true, token })
  })

  it('rejects missing header', () => {
    expect(parseBearerAuthorizationHeader(undefined)).toEqual({ ok: false, reason: 'missing_header' })
    expect(parseBearerAuthorizationHeader('')).toEqual({ ok: false, reason: 'missing_header' })
    expect(parseBearerAuthorizationHeader('   ')).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('rejects duplicate Authorization values', () => {
    const r = parseBearerAuthorizationHeader(['Bearer a', 'Bearer b'])
    expect(r).toEqual({ ok: false, reason: 'duplicate_authorization_header' })
  })

  it('rejects wrong scheme or split token (extra words)', () => {
    expect(parseBearerAuthorizationHeader('Basic xyz')).toEqual({ ok: false, reason: 'malformed_scheme' })
    expect(parseBearerAuthorizationHeader('Bearer')).toEqual({ ok: false, reason: 'malformed_scheme' })
    expect(parseBearerAuthorizationHeader('Bearer one two')).toEqual({ ok: false, reason: 'malformed_scheme' })
  })

  it('rejects trailing junk after token', () => {
    expect(parseBearerAuthorizationHeader('Bearer tok extra')).toEqual({ ok: false, reason: 'malformed_scheme' })
  })

  it('rejects control characters inside token', () => {
    const r = parseBearerAuthorizationHeader('Bearer bad\nline')
    expect(r).toEqual({ ok: false, reason: 'malformed_scheme' })
    const r2 = parseBearerAuthorizationHeader(`Bearer ${'x'}\x01`)
    expect(r2).toEqual({ ok: false, reason: 'invalid_credentials' })
  })

  it('rejects oversized credential', () => {
    const huge = 'a'.repeat(BEARER_CREDENTIAL_MAX_OCTETS + 1)
    const r = parseBearerAuthorizationHeader(`Bearer ${huge}`)
    expect(r).toEqual({ ok: false, reason: 'credentials_too_long' })
  })

  it('accepts token at max length', () => {
    const token = 'a'.repeat(BEARER_CREDENTIAL_MAX_OCTETS)
    const r = parseBearerAuthorizationHeader(`Bearer ${token}`)
    expect(r).toEqual({ ok: true, token })
  })

  it('accepts single-array header with high-entropy opaque token', () => {
    const token = 'TestBearerTokenForE2ETestingOnly'
    const r = parseBearerAuthorizationHeader([`Bearer ${token}`])
    expect(r).toEqual({ ok: true, token })
  })

  it('accepts 32-char hex opaque token', () => {
    const token = 'TestBearerTokenForE2ETestingOnly'
    const r = parseBearerAuthorizationHeader(`Bearer ${token}`)
    expect(r).toEqual({ ok: true, token })
  })

  it('accepts high-entropy base64url opaque token', () => {
    const token = 'a'.repeat(BEARER_OPAQUE_MIN_OCTETS)
    const r = parseBearerAuthorizationHeader(`Bearer ${token}`)
    expect(r).toEqual({ ok: true, token })
  })

  it('rejects weak credentials — short human-readable string', () => {
    expect(parseBearerAuthorizationHeader('Bearer demo-token-123')).toEqual({ ok: false, reason: 'weak_credentials' })
    expect(parseBearerAuthorizationHeader('Bearer foobar')).toEqual({ ok: false, reason: 'weak_credentials' })
    expect(parseBearerAuthorizationHeader('Bearer short')).toEqual({ ok: false, reason: 'weak_credentials' })
  })

  it('rejects opaque token that is too short', () => {
    const token = 'a'.repeat(BEARER_OPAQUE_MIN_OCTETS - 1)
    expect(parseBearerAuthorizationHeader(`Bearer ${token}`)).toEqual({ ok: false, reason: 'weak_credentials' })
  })

  it('accepts alg:none JWT structure (crypto validation is the strategy layer\'s responsibility)', () => {
    // eyJhbGciOiJub25lIn0 = base64url({"alg":"none"})
    // Structural check deliberately passes — whether alg:none is acceptable is the
    // auth strategy's concern, not the header parser's.
    const algNoneToken = 'eyJhbGciOiJub25lIn0.e30.'
    const r = parseBearerAuthorizationHeader(`Bearer ${algNoneToken}`)
    expect(r).toEqual({ ok: true, token: algNoneToken })
  })
})

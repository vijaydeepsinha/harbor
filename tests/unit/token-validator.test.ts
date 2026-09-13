// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { OAuthIntrospectionStrategy } from '../../adapters/auth/strategies/oauth-introspection.strategy.js'
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../core/types/auth.types.js'

vi.mock('axios')

const config = {
  host: 'auth.example.com',
  port: 8083,
  introspectionPath: '/oauth/introspect',
  authTimeoutMs: 5000,
  method: 'POST' as const,
}

describe('OAuthIntrospectionStrategy', () => {
  let strategy: OAuthIntrospectionStrategy
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  beforeEach(() => {
    strategy = new OAuthIntrospectionStrategy(config)
    vi.clearAllMocks()
  })

  it('valid token returns TokenPayload', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 200,
      data: {
        access_token: 'abc',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'xyz',
        scope: 'login_mode:self'
      }
    })

    const result = await strategy.validate('valid-token')
    expect(result.access_token).toBe('abc')
    expect(result.expires_in).toBe(3600)
  })

  it('expires_in: 0 throws TokenExpiredError', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 200,
      data: {
        access_token: 'abc',
        token_type: 'bearer',
        expires_in: 0,
        refresh_token: 'xyz',
        scope: 'login_mode:self'
      }
    })

    await expect(strategy.validate('expired-token')).rejects.toThrow(TokenExpiredError)
  })

  it('auth server 401 throws TokenInvalidError', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 401,
      data: { error: 'invalid_token' }
    })

    await expect(strategy.validate('bad-token')).rejects.toThrow(TokenInvalidError)
  })

  it('auth server 403 throws TokenInvalidError', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      status: 403,
      data: { error: 'insufficient_scope' }
    })

    await expect(strategy.validate('bad-token')).rejects.toThrow(TokenInvalidError)
  })

  it('network failure throws TokenIntrospectionError', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(strategy.validate('some-token')).rejects.toThrow(TokenIntrospectionError)
  })

  it('raw token never appears in any log output', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('ECONNREFUSED'))

    try {
      await strategy.validate('super-secret-raw-token-value')
    } catch {
      // expected
    }

    const allLogCalls = logSpy.mock.calls.flat().join(' ')
    expect(allLogCalls).not.toContain('super-secret-raw-token-value')
  })

  describe('resource binding (spec §17, RFC 8707) — best-effort, RFC 7662 `aud` is optional', () => {
    it('no audience configured → aud claim in response is ignored', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'abc', expires_in: 3600, aud: 'https://not-harbor.example.com' }
      })

      const result = await strategy.validate('token')
      expect(result.access_token).toBe('abc')
    })

    it('audience configured, response has no aud claim → validation skipped (accepted)', async () => {
      const s = new OAuthIntrospectionStrategy({ ...config, audience: 'https://harbor.example.com' })
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'abc', expires_in: 3600 }
      })

      const result = await s.validate('token')
      expect(result.access_token).toBe('abc')
    })

    it('audience configured, response aud matches (string) → accepted', async () => {
      const s = new OAuthIntrospectionStrategy({ ...config, audience: 'https://harbor.example.com' })
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'abc', expires_in: 3600, aud: 'https://harbor.example.com' }
      })

      const result = await s.validate('token')
      expect(result.access_token).toBe('abc')
    })

    it('audience configured, response aud matches (array) → accepted', async () => {
      const s = new OAuthIntrospectionStrategy({ ...config, audience: 'https://harbor.example.com' })
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'abc', expires_in: 3600, aud: ['https://other.example.com', 'https://harbor.example.com'] }
      })

      const result = await s.validate('token')
      expect(result.access_token).toBe('abc')
    })

    it('audience configured, response aud mismatches → TokenInvalidError (rejected)', async () => {
      const s = new OAuthIntrospectionStrategy({ ...config, audience: 'https://harbor.example.com' })
      vi.mocked(axios.post).mockResolvedValueOnce({
        status: 200,
        data: { access_token: 'abc', expires_in: 3600, aud: 'https://not-harbor.example.com' }
      })

      await expect(s.validate('token')).rejects.toThrow(TokenInvalidError)
    })
  })
})

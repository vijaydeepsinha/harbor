// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import axios from 'axios'
import {OAuthIntrospectionStrategy} from '../../src/adapters/auth/strategies/oauth-introspection.strategy.js'
import {TokenExpiredError, TokenIntrospectionError, TokenInvalidError} from '../../src/core/types/auth.types.js'

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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    })

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
            data: {error: 'invalid_token'}
        })

        await expect(strategy.validate('bad-token')).rejects.toThrow(TokenInvalidError)
    })

    it('auth server 403 throws TokenInvalidError', async () => {
        vi.mocked(axios.post).mockResolvedValueOnce({
            status: 403,
            data: {error: 'insufficient_scope'}
        })

        await expect(strategy.validate('bad-token')).rejects.toThrow(TokenInvalidError)
    })

    it('an RFC 7662 response with active:false is rejected, whatever else it carries', async () => {
        for (const active of [false, 'true', 0]) {
            vi.mocked(axios.post).mockResolvedValueOnce({
                status: 200,
                data: {active, expires_in: 3600, sub: 'revoked-user'}
            })
            await expect(strategy.validate('revoked'), String(active)).rejects.toThrow(TokenInvalidError)
        }
        vi.mocked(axios.post).mockResolvedValueOnce({status: 200, data: {active: true, expires_in: 3600}})
        expect((await strategy.validate('live')).expires_in).toBe(3600)
    })

    it('reads RFC 7662 exp (absolute) as the remaining lifetime, and refuses one in the past', async () => {
        const now = Math.floor(Date.now() / 1000)
        vi.mocked(axios.post).mockResolvedValueOnce({status: 200, data: {active: true, exp: now + 600}})
        const live = await strategy.validate('t')
        expect(live.expires_in).toBeGreaterThan(590)
        expect(live.expires_in).toBeLessThanOrEqual(600)
        vi.mocked(axios.post).mockResolvedValueOnce({status: 200, data: {active: true, exp: now - 86_400}})
        await expect(strategy.validate('t')).rejects.toThrow(TokenExpiredError)
        // An epoch timestamp mapped onto expires_in is read as absolute, not as a lifetime of decades.
        const mapped = new OAuthIntrospectionStrategy({...config, responseMapping: {expires_in: 'exp'}})
        vi.mocked(axios.post).mockResolvedValueOnce({status: 200, data: {exp: now - 86_400}})
        await expect(mapped.validate('t')).rejects.toThrow(TokenExpiredError)
    })

    it('a transport failure names the error code but never the auth server\'s address', async () => {
        vi.mocked(axios.post).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:8083'), {code: 'ECONNREFUSED'}))
        const err = await strategy.validate('t').catch((e: unknown) => e) as Error
        expect(err).toBeInstanceOf(TokenIntrospectionError)
        expect(err.message).toContain('ECONNREFUSED')
        expect(err.message).not.toContain('10.0.0.7')
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
                data: {access_token: 'abc', expires_in: 3600, aud: 'https://not-harbor.example.com'}
            })

            const result = await strategy.validate('token')
            expect(result.access_token).toBe('abc')
        })

        it('audience configured, response has no aud claim → validation skipped (accepted)', async () => {
            const s = new OAuthIntrospectionStrategy({...config, audience: 'https://harbor.example.com'})
            vi.mocked(axios.post).mockResolvedValueOnce({
                status: 200,
                data: {access_token: 'abc', expires_in: 3600}
            })

            const result = await s.validate('token')
            expect(result.access_token).toBe('abc')
        })

        it('audience configured, response aud matches (string) → accepted', async () => {
            const s = new OAuthIntrospectionStrategy({...config, audience: 'https://harbor.example.com'})
            vi.mocked(axios.post).mockResolvedValueOnce({
                status: 200,
                data: {access_token: 'abc', expires_in: 3600, aud: 'https://harbor.example.com'}
            })

            const result = await s.validate('token')
            expect(result.access_token).toBe('abc')
        })

        it('audience configured, response aud matches (array) → accepted', async () => {
            const s = new OAuthIntrospectionStrategy({...config, audience: 'https://harbor.example.com'})
            vi.mocked(axios.post).mockResolvedValueOnce({
                status: 200,
                data: {
                    access_token: 'abc',
                    expires_in: 3600,
                    aud: ['https://other.example.com', 'https://harbor.example.com']
                }
            })

            const result = await s.validate('token')
            expect(result.access_token).toBe('abc')
        })

        it('audience configured, response aud mismatches → TokenInvalidError (rejected)', async () => {
            const s = new OAuthIntrospectionStrategy({...config, audience: 'https://harbor.example.com'})
            vi.mocked(axios.post).mockResolvedValueOnce({
                status: 200,
                data: {access_token: 'abc', expires_in: 3600, aud: 'https://not-harbor.example.com'}
            })

            await expect(s.validate('token')).rejects.toThrow(TokenInvalidError)
        })
    })
})

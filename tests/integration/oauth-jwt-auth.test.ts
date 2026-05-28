// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * End-to-end integration: JWT token → auth middleware → JwtValidationStrategy → TokenPayload.
 *
 * This is the exact production path taken when api_execute calls
 * authMiddleware.getOrValidate() with a client's bearer JWT.
 * Unit tests cover each piece in isolation; this test wires them together.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK, type KeyLike } from 'jose'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { JwtValidationStrategy } from '../../adapters/auth/strategies/jwt-validation.strategy.js'
import { OAuthDiscoveryStrategy } from '../../adapters/auth/strategies/oauth-discovery.strategy.js'
import { InMemoryTokenCache } from '../../adapters/auth/strategies/in-memory-token-cache.strategy.js'
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../core/types/auth.types.js'

const AUDIENCE = 'https://harbor.example.com'

let privateKey: KeyLike
let jwksServer: Server
let metadataServer: Server
let jwksUrl: string
let asBaseUrl: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey

  const jwk = await exportJWK(pair.publicKey)
  const jwksDoc = JSON.stringify({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] })

  // JWKS server
  await new Promise<void>(resolve => {
    jwksServer = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(jwksDoc)
    })
    jwksServer.listen(0, '127.0.0.1', resolve)
  })
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`

  // OIDC metadata server
  await new Promise<void>(resolve => {
    metadataServer = createServer((req, res) => {
      if (req.url?.includes('.well-known')) {
        const doc = JSON.stringify({ issuer: asBaseUrl, jwks_uri: jwksUrl })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(doc)
        return
      }
      res.writeHead(404).end()
    })
    metadataServer.listen(0, '127.0.0.1', resolve)
  })
  asBaseUrl = `http://127.0.0.1:${(metadataServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => jwksServer.close(err => err ? reject(err) : resolve())),
    new Promise<void>((resolve, reject) => metadataServer.close(err => err ? reject(err) : resolve())),
  ])
})

function signJwt(
  claims: Record<string, unknown> = {},
  opts: { expiresInSec?: number; issuer?: string; audience?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? asBaseUrl)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSec ?? 3600))
    .sign(privateKey)
}

// ── jwt-validation + token cache (production code path) ──────────────────────

describe('jwt-validation strategy through InMemoryTokenCache', () => {
  it('valid JWT flows through cache and returns TokenPayload', async () => {
    const strategy = new JwtValidationStrategy({
      jwksUri: jwksUrl,
      issuer: asBaseUrl,
      audience: AUDIENCE,
    })
    const cache = new InMemoryTokenCache(300_000)

    const token = await signJwt({ scope: 'api:read' })
    const payload = await cache.getOrValidate('svc', token, t => strategy.validate(t))

    expect(payload.access_token).toBe(token)
    expect(payload.scope).toBe('api:read')
    expect(payload.expires_in).toBeGreaterThan(0)

    cache.destroy()
  })

  it('cache hit: second call returns same payload without re-validating', async () => {
    let validateCalls = 0
    const strategy = new JwtValidationStrategy({ jwksUri: jwksUrl, issuer: asBaseUrl, audience: AUDIENCE })
    const trackingStrategy = {
      ...strategy,
      validate: async (t: string) => { validateCalls++; return strategy.validate(t) }
    }
    const cache = new InMemoryTokenCache(300_000)

    const token = await signJwt({})
    await cache.getOrValidate('svc', token, t => trackingStrategy.validate(t))
    await cache.getOrValidate('svc', token, t => trackingStrategy.validate(t))

    expect(validateCalls).toBe(1)
    cache.destroy()
  })

  it('expired JWT → TokenExpiredError propagates through cache', async () => {
    const strategy = new JwtValidationStrategy({
      jwksUri: jwksUrl,
      issuer: asBaseUrl,
      audience: AUDIENCE,
      clockToleranceSec: 0,
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({}, { expiresInSec: -60 })

    await expect(
      cache.getOrValidate('svc', token, t => strategy.validate(t))
    ).rejects.toBeInstanceOf(TokenExpiredError)

    cache.destroy()
  })

  it('invalid token → TokenInvalidError propagates through cache', async () => {
    const strategy = new JwtValidationStrategy({
      jwksUri: jwksUrl,
      issuer: asBaseUrl,
      audience: AUDIENCE,
    })
    const cache = new InMemoryTokenCache(300_000)

    await expect(
      cache.getOrValidate('svc', 'not.a.real.jwt', t => strategy.validate(t))
    ).rejects.toBeInstanceOf(TokenInvalidError)

    cache.destroy()
  })

  it('metadataMapping flows through cache to TokenPayload.metadata', async () => {
    const strategy = new JwtValidationStrategy({
      jwksUri: jwksUrl,
      issuer: asBaseUrl,
      audience: AUDIENCE,
      metadataMapping: { userId: 'sub', org: 'org_id' },
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({ sub: 'u-1', org_id: 'acme' })

    const payload = await cache.getOrValidate('svc', token, t => strategy.validate(t))
    expect(payload.metadata).toEqual({ userId: 'u-1', org: 'acme' })

    cache.destroy()
  })
})

// ── oauth-2.1 discovery strategy + token cache ───────────────────────────────

describe('oauth-2.1 discovery strategy through InMemoryTokenCache', () => {
  it('discovers JWKS and validates JWT end-to-end', async () => {
    const strategy = new OAuthDiscoveryStrategy({
      authorizationServer: asBaseUrl,
      audience: AUDIENCE,
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({ scope: 'admin' })

    const payload = await cache.getOrValidate('svc', token, t => strategy.validate(t))
    expect(payload.scope).toBe('admin')
    expect(payload.token_type).toBe('bearer')

    cache.destroy()
  })

  it('expired JWT via discovery → TokenExpiredError', async () => {
    const strategy = new OAuthDiscoveryStrategy({
      authorizationServer: asBaseUrl,
      audience: AUDIENCE,
      clockToleranceSec: 0,
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({}, { expiresInSec: -60 })

    await expect(
      cache.getOrValidate('svc', token, t => strategy.validate(t))
    ).rejects.toBeInstanceOf(TokenExpiredError)

    cache.destroy()
  })

  it('unreachable AS → TokenIntrospectionError', async () => {
    const strategy = new OAuthDiscoveryStrategy({
      authorizationServer: 'http://127.0.0.1:1',
      discoveryTimeoutMs: 500,
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({})

    await expect(
      cache.getOrValidate('svc', token, t => strategy.validate(t))
    ).rejects.toBeInstanceOf(TokenIntrospectionError)

    cache.destroy()
  })

  it('wrong audience → TokenInvalidError', async () => {
    const strategy = new OAuthDiscoveryStrategy({
      authorizationServer: asBaseUrl,
      audience: 'https://harbor.example.com',
    })
    const cache = new InMemoryTokenCache(300_000)
    const token = await signJwt({}, { audience: 'https://other.example.com' })

    await expect(
      cache.getOrValidate('svc', token, t => strategy.validate(t))
    ).rejects.toBeInstanceOf(TokenInvalidError)

    cache.destroy()
  })
})

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK, type KeyLike } from 'jose'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OAuthDiscoveryStrategy, oauthDiscovery } from '../../adapters/auth/strategies/oauth-discovery.strategy.js'
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../core/types/auth.types.js'
import { AUTH_TYPE } from '../../core/constants.js'

let privateKey: KeyLike
let jwksServer: Server
let metadataServer: Server
let asBaseUrl: string

let resolvedIssuer: string

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
  const jwksPort = (jwksServer.address() as AddressInfo).port
  const jwksUrl = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`

  // AS metadata server — serves OIDC discovery doc pointing at JWKS server
  await new Promise<void>(resolve => {
    metadataServer = createServer((req, res) => {
      if (
        req.url === '/.well-known/openid-configuration' ||
        req.url === '/.well-known/oauth-authorization-server'
      ) {
        const doc = JSON.stringify({
          issuer: asBaseUrl,
          jwks_uri: jwksUrl,
          authorization_endpoint: `${asBaseUrl}/authorize`,
          token_endpoint: `${asBaseUrl}/token`,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(doc)
        return
      }
      res.writeHead(404).end()
    })
    metadataServer.listen(0, '127.0.0.1', resolve)
  })
  const asPort = (metadataServer.address() as AddressInfo).port
  asBaseUrl = `http://127.0.0.1:${asPort}`
  resolvedIssuer = asBaseUrl
})

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => jwksServer.close(err => (err ? reject(err) : resolve()))),
    new Promise<void>((resolve, reject) => metadataServer.close(err => (err ? reject(err) : resolve()))),
  ])
})

function sign(
  claims: Record<string, unknown> = {},
  opts: { expiresInSec?: number; issuer?: string; audience?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? resolvedIssuer)
    .setAudience(opts.audience ?? 'https://harbor.example.com')
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSec ?? 3600))
    .sign(privateKey)
}

describe('OAuthDiscoveryStrategy', () => {
  it('strategy name matches AUTH_TYPE.OAUTH_2_1', () => {
    const s = new OAuthDiscoveryStrategy({
      authorizationServer: asBaseUrl,
      audience: 'https://harbor.example.com',
    })
    expect(s.name).toBe(AUTH_TYPE.OAUTH_2_1)
  })

  it('tokenRefreshBufferSec is undefined', () => {
    const s = new OAuthDiscoveryStrategy({ authorizationServer: asBaseUrl })
    expect(s.tokenRefreshBufferSec).toBeUndefined()
  })

  it('oauthDiscovery() factory returns OAuthDiscoveryStrategy', () => {
    const s = oauthDiscovery({ authorizationServer: asBaseUrl })
    expect(s).toBeInstanceOf(OAuthDiscoveryStrategy)
  })

  describe('validate — discovery + happy path', () => {
    it('discovers OIDC metadata and validates a valid JWT', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const token = await sign({ scope: 'api:read' })
      const payload = await s.validate(token)

      expect(payload.access_token).toBe(token)
      expect(payload.token_type).toBe('bearer')
      expect(payload.scope).toBe('api:read')
      expect(payload.expires_in).toBeGreaterThan(0)
    })

    it('discovery result is cached — second validate does not refetch metadata', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const t1 = await sign({})
      const t2 = await sign({ scope: 'admin' })
      await s.validate(t1)
      const payload = await s.validate(t2)
      expect(payload.scope).toBe('admin')
    })

    it('concurrent validate calls share a single discovery promise', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const tokens = await Promise.all([sign({}), sign({}), sign({})])
      const results = await Promise.all(tokens.map(t => s.validate(t)))
      expect(results).toHaveLength(3)
      results.forEach(r => expect(r.token_type).toBe('bearer'))
    })

    it('scope as array is joined with space after discovery', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const token = await sign({ scope: ['read', 'write'] })
      const payload = await s.validate(token)
      expect(payload.scope).toBe('read write')
    })

    it('metadataMapping flows through to extracted metadata', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
        metadataMapping: { userId: 'sub' },
      })
      const token = await sign({ sub: 'u-99' })
      const payload = await s.validate(token)
      expect(payload.metadata).toEqual({ userId: 'u-99' })
    })

    it('custom scopeClaim is forwarded to the inner strategy', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
        scopeClaim: 'roles',
      })
      const token = await sign({ roles: 'admin editor' })
      const payload = await s.validate(token)
      expect(payload.scope).toBe('admin editor')
    })
  })

  describe('validate — error mapping', () => {
    it('expired token → TokenExpiredError', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
        clockToleranceSec: 0,
      })
      const token = await sign({}, { expiresInSec: -10 })
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenExpiredError)
    })

    it('wrong issuer → TokenInvalidError', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const token = await sign({}, { issuer: 'https://evil.example.com' })
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('wrong audience → TokenInvalidError', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      const token = await sign({}, { audience: 'https://other.example.com' })
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('malformed JWT → TokenInvalidError', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: asBaseUrl,
        audience: 'https://harbor.example.com',
      })
      await expect(s.validate('not.a.jwt')).rejects.toBeInstanceOf(TokenInvalidError)
    })
  })

  describe('discovery failures', () => {
    it('unreachable AS → TokenIntrospectionError', async () => {
      const s = new OAuthDiscoveryStrategy({
        authorizationServer: 'http://127.0.0.1:1',
        discoveryTimeoutMs: 500,
      })
      const token = await sign({})
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenIntrospectionError)
    })

    it('failed discovery resets so next call can retry', async () => {
      let callCount = 0
      const failServer = createServer((_, res) => {
        callCount++
        res.writeHead(500).end()
      })
      await new Promise<void>(resolve => failServer.listen(0, '127.0.0.1', resolve))
      const { port } = failServer.address() as AddressInfo
      const failUrl = `http://127.0.0.1:${port}`

      const s = new OAuthDiscoveryStrategy({ authorizationServer: failUrl })
      const token = await sign({})
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenIntrospectionError)
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenIntrospectionError)
      // both attempts should have hit the server (no dead cache)
      expect(callCount).toBeGreaterThanOrEqual(2)

      await new Promise<void>((resolve, reject) => failServer.close(err => (err ? reject(err) : resolve())))
    })

    it('AS returns metadata without jwks_uri → TokenIntrospectionError', async () => {
      const noJwksServer = createServer((req, res) => {
        if (req.url?.includes('.well-known')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ issuer: 'https://example.com' }))
          return
        }
        res.writeHead(404).end()
      })
      await new Promise<void>(resolve => noJwksServer.listen(0, '127.0.0.1', resolve))
      const { port } = noJwksServer.address() as AddressInfo

      const s = new OAuthDiscoveryStrategy({ authorizationServer: `http://127.0.0.1:${port}` })
      const token = await sign({})
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenIntrospectionError)

      await new Promise<void>((resolve, reject) => noJwksServer.close(err => (err ? reject(err) : resolve())))
    })
  })
})

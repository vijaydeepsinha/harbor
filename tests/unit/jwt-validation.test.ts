// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPair, SignJWT, exportJWK, type KeyLike } from 'jose'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { JwtValidationStrategy, jwtValidation } from '../../adapters/auth/strategies/jwt-validation.strategy.js'
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../core/types/auth.types.js'
import { AUTH_TYPE } from '../../core/constants.js'

let privateKey: KeyLike
let otherPrivateKey: KeyLike
let jwksServer: Server
let jwksUrl: string
let strategy: JwtValidationStrategy

const ISSUER = 'https://auth.example.com'
const AUDIENCE = 'https://harbor.example.com'

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  const otherPair = await generateKeyPair('RS256')
  otherPrivateKey = otherPair.privateKey

  const jwk = await exportJWK(pair.publicKey)
  const jwksDoc = JSON.stringify({ keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] })

  await new Promise<void>(resolve => {
    jwksServer = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(jwksDoc)
    })
    jwksServer.listen(0, '127.0.0.1', resolve)
  })

  const { port } = jwksServer.address() as AddressInfo
  jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`

  strategy = new JwtValidationStrategy({ jwksUri: jwksUrl, issuer: ISSUER, audience: AUDIENCE })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    jwksServer.close(err => (err ? reject(err) : resolve()))
  )
})

function sign(
  claims: Record<string, unknown> = {},
  opts: { expiresInSec?: number; issuer?: string; audience?: string; noExp?: boolean } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  let builder = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt(now)

  if (!opts.noExp) {
    builder = builder.setExpirationTime(now + (opts.expiresInSec ?? 3600))
  }
  if (opts.audience !== undefined) {
    builder = builder.setAudience(opts.audience)
  } else {
    builder = builder.setAudience(AUDIENCE)
  }
  return builder.sign(privateKey)
}

describe('JwtValidationStrategy', () => {
  it('strategy name matches AUTH_TYPE.JWT_VALIDATION', () => {
    expect(strategy.name).toBe(AUTH_TYPE.JWT_VALIDATION)
  })

  it('tokenRefreshBufferSec is undefined', () => {
    expect(strategy.tokenRefreshBufferSec).toBeUndefined()
  })

  it('jwtValidation() factory returns a JwtValidationStrategy', () => {
    const s = jwtValidation({ jwksUri: jwksUrl, issuer: ISSUER })
    expect(s).toBeInstanceOf(JwtValidationStrategy)
  })

  describe('validate — happy path', () => {
    it('valid RS256 JWT returns correct TokenPayload shape', async () => {
      const token = await sign({ scope: 'api:read' })
      const payload = await strategy.validate(token)

      expect(payload.access_token).toBe(token)
      expect(payload.token_type).toBe('bearer')
      expect(payload.scope).toBe('api:read')
      expect(payload.expires_in).toBeGreaterThan(0)
      expect(payload.expires_in).toBeLessThanOrEqual(3600)
    })

    it('expires_in reflects time remaining from exp claim', async () => {
      const token = await sign({}, { expiresInSec: 1800 })
      const payload = await strategy.validate(token)
      expect(payload.expires_in).toBeGreaterThan(1790)
      expect(payload.expires_in).toBeLessThanOrEqual(1800)
    })

    it('scope as array is joined with space', async () => {
      const token = await sign({ scope: ['api:read', 'api:write'] })
      const payload = await strategy.validate(token)
      expect(payload.scope).toBe('api:read api:write')
    })

    it('scope absent → empty string', async () => {
      const token = await sign({})
      const payload = await strategy.validate(token)
      expect(payload.scope).toBe('')
    })

    it('custom scopeClaim extracts the right claim', async () => {
      const s = new JwtValidationStrategy({
        jwksUri: jwksUrl, issuer: ISSUER, audience: AUDIENCE,
        scopeClaim: 'permissions'
      })
      const token = await sign({ permissions: 'admin:read' })
      const payload = await s.validate(token)
      expect(payload.scope).toBe('admin:read')
    })

    it('metadataMapping extracts mapped claims into metadata', async () => {
      const s = new JwtValidationStrategy({
        jwksUri: jwksUrl, issuer: ISSUER, audience: AUDIENCE,
        metadataMapping: { userId: 'sub', clientId: 'client_id' }
      })
      const token = await sign({ sub: 'user-42', client_id: 'my-app' })
      const payload = await s.validate(token)
      expect(payload.metadata).toEqual({ userId: 'user-42', clientId: 'my-app' })
    })

    it('metadataMapping skips claims absent from token', async () => {
      const s = new JwtValidationStrategy({
        jwksUri: jwksUrl, issuer: ISSUER, audience: AUDIENCE,
        metadataMapping: { userId: 'sub', missing: 'no_such_claim' }
      })
      const token = await sign({ sub: 'user-1' })
      const payload = await s.validate(token)
      expect(payload.metadata).toEqual({ userId: 'user-1' })
    })

    it('omits metadata key when no mapping configured', async () => {
      const token = await sign({ sub: 'user-1' })
      const payload = await strategy.validate(token)
      expect(payload.metadata).toBeUndefined()
    })

    it('strategy without audience accepts tokens regardless of aud claim', async () => {
      const s = new JwtValidationStrategy({ jwksUri: jwksUrl, issuer: ISSUER })
      const token = await sign({}, { audience: 'any-audience' })
      const payload = await s.validate(token)
      expect(payload.token_type).toBe('bearer')
    })
  })

  describe('validate — error mapping', () => {
    it('expired JWT → TokenExpiredError', async () => {
      const s = new JwtValidationStrategy({
        jwksUri: jwksUrl, issuer: ISSUER, audience: AUDIENCE,
        clockToleranceSec: 0
      })
      const token = await sign({}, { expiresInSec: -10 })
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenExpiredError)
    })

    it('wrong issuer → TokenInvalidError', async () => {
      const token = await sign({}, { issuer: 'https://evil.example.com' })
      await expect(strategy.validate(token)).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('wrong audience → TokenInvalidError', async () => {
      const token = await sign({}, { audience: 'https://other-resource.example.com' })
      await expect(strategy.validate(token)).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('token signed with unknown key → TokenInvalidError', async () => {
      const now = Math.floor(Date.now() / 1000)
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(otherPrivateKey)
      await expect(strategy.validate(token)).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('malformed JWT string → TokenInvalidError', async () => {
      await expect(strategy.validate('not.a.jwt')).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('completely garbled input → TokenInvalidError', async () => {
      await expect(strategy.validate('garbage')).rejects.toBeInstanceOf(TokenInvalidError)
    })

    it('JWKS endpoint unreachable → TokenIntrospectionError', async () => {
      const s = new JwtValidationStrategy({
        jwksUri: 'http://127.0.0.1:1/.well-known/jwks.json',
        issuer: ISSUER,
      })
      const token = await sign({})
      await expect(s.validate(token)).rejects.toBeInstanceOf(TokenIntrospectionError)
    })
  })
})

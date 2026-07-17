// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { startHttpGateway, type HttpGatewayHandle } from '../../runtime/http/http-gateway.js'
import { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { Logger } from '../../runtime/observability/logger.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { HTTP_ROUTES } from '../../core/constants.js'

function makeLogger(): Logger {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => makeLogger() } as unknown as Logger
}

const baseOAuthConfig: OAuthResourceConfig = {
  resourceUri: 'https://harbor.example.com',
  authorizationServers: ['https://auth.example.com'],
}

async function startForTest(oauthConfig?: OAuthResourceConfig): Promise<{
  handle: HttpGatewayHandle
  baseUrl: string
  close: () => Promise<void>
}> {
  const handle = startHttpGateway({
    host: '127.0.0.1',
    port: 0,
    createMcpServer: () => { throw new Error('not expected') },
    registry: new ServiceRegistry(),
    logger: makeLogger(),
    oauthConfig
  })
  await new Promise<void>(resolve => handle.server.once('listening', () => resolve()))
  const { port } = handle.server.address() as AddressInfo
  return {
    handle,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      handle.server.close(err => err ? reject(err) : resolve())
    })
  }
}

describe('OAuth 2.0 Protected Resource Metadata endpoint', () => {
  let cleanup: (() => Promise<void>) | null = null

  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null }
  })

  it('returns 200 with correct RFC 9728 document shape', async () => {
    const { baseUrl, close } = await startForTest(baseOAuthConfig)
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json() as Record<string, unknown>
    expect(body.resource).toBe('https://harbor.example.com')
    expect(body.authorization_servers).toEqual(['https://auth.example.com'])
    expect(body.bearer_methods_supported).toEqual(['header'])
  })

  it('sub-path /mcp variant returns the same document', async () => {
    const { baseUrl, close } = await startForTest(baseOAuthConfig)
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE_MCP}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.resource).toBe('https://harbor.example.com')
  })

  it('includes scopes_supported when configured', async () => {
    const { baseUrl, close } = await startForTest({
      ...baseOAuthConfig,
      scopesSupported: ['api:read', 'api:write']
    })
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    const body = await res.json() as Record<string, unknown>
    expect(body.scopes_supported).toEqual(['api:read', 'api:write'])
  })

  it('omits scopes_supported when not configured', async () => {
    const { baseUrl, close } = await startForTest(baseOAuthConfig)
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    const body = await res.json() as Record<string, unknown>
    expect(body.scopes_supported).toBeUndefined()
  })

  it('returns 404 when oauthConfig is not set', async () => {
    const { baseUrl, close } = await startForTest(undefined)
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    expect(res.status).toBe(404)
  })

  it('metadata endpoint requires no Authorization header', async () => {
    const { baseUrl, close } = await startForTest(baseOAuthConfig)
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    expect(res.status).toBe(200)
  })

  it('multiple authorization_servers are included verbatim', async () => {
    const { baseUrl, close } = await startForTest({
      resourceUri: 'https://harbor.example.com',
      authorizationServers: ['https://auth1.example.com', 'https://auth2.example.com']
    })
    cleanup = close

    const res = await fetch(`${baseUrl}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`)
    const body = await res.json() as Record<string, unknown>
    expect(body.authorization_servers).toEqual(['https://auth1.example.com', 'https://auth2.example.com'])
  })

  it('POST /mcp without token + oauthConfig set returns WWW-Authenticate header', async () => {
    const { baseUrl, close } = await startForTest(baseOAuthConfig)
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    const wwwAuth = res.headers.get('www-authenticate')
    expect(wwwAuth).not.toBeNull()
    expect(wwwAuth).toContain('Bearer resource_metadata=')
    expect(wwwAuth).toContain('https://harbor.example.com/.well-known/oauth-protected-resource')
  })

  it('POST /mcp without token + no oauthConfig returns no WWW-Authenticate header', async () => {
    const { baseUrl, close } = await startForTest(undefined)
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})

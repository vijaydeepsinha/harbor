// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import axios from 'axios'
import type { AuthStrategy, TokenPayload } from '../../../core/types/auth.types.js'
import {
  AuthError,
  TokenExpiredError,
  TokenInvalidError,
  TokenIntrospectionError
} from '../../../core/types/auth.types.js'
import { AUTH_TYPE, AUTH_SCHEME, HTTP_HEADER, CONTENT_TYPE_JSON } from '../../../core/constants.js'
import { joinUrl } from '../../../core/utils/url.js'

/**
 * Maps auth-server response fields to TokenPayload fields via dot-path notation.
 * For example, { access_token: 'tokenResponse.token' } means the value at
 * `responseBody.tokenResponse.token` is used as `access_token`.
 */
export interface ResponseMapping {
  access_token?: string
  expires_in?: string
  refresh_token?: string
  scope?: string
}

/**
 * Dot-path mappings for extracting additional metadata (userId, accountId, etc.)
 * from the auth-server response into `TokenPayload.metadata`.
 */
export type MetadataMapping = Record<string, string>

export interface OAuthIntrospectionConfig {
  protocol?: 'http' | 'https'
  host: string
  port: number
  introspectionPath: string
  authTimeoutMs: number
  method?: 'GET' | 'POST'
  tokenPassMode?: 'query' | 'body' | 'header'
  tokenParamName?: string
  refreshPath?: string
  tokenRefreshBufferSec?: number
  responseMapping?: ResponseMapping
  metadataMapping?: MetadataMapping
}

export class OAuthIntrospectionStrategy implements AuthStrategy {
  readonly name = AUTH_TYPE.OAUTH_INTROSPECTION
  readonly tokenRefreshBufferSec?: number
  private readonly baseUrl: string
  private readonly refreshUrl?: string
  private readonly method: 'GET' | 'POST'
  private readonly tokenPassMode: 'query' | 'body' | 'header'
  private readonly tokenParamName: string
  private readonly responseMapping: ResponseMapping
  private readonly metadataMapping: MetadataMapping

  constructor(private readonly config: OAuthIntrospectionConfig) {
    const scheme = config.protocol ?? 'http'
    const isDefaultPort = (scheme === 'https' && config.port === 443) || (scheme === 'http' && config.port === 80)
    const origin = `${scheme}://${config.host}${isDefaultPort ? '' : `:${config.port}`}`

    this.baseUrl = joinUrl(origin, config.introspectionPath)
    this.method = config.method ?? 'GET'
    this.tokenPassMode = config.tokenPassMode ?? 'query'
    this.tokenParamName = config.tokenParamName ?? 'token'
    this.tokenRefreshBufferSec = config.tokenRefreshBufferSec ?? 300
    this.responseMapping = config.responseMapping ?? {}
    this.metadataMapping = config.metadataMapping ?? {}

    if (config.refreshPath) {
      this.refreshUrl = joinUrl(origin, config.refreshPath)
    }
  }

  async validate(rawToken: string): Promise<TokenPayload> {
    try {
      const response = await this.callAuthService(rawToken)

      if (response.status === 401 || response.status === 403) {
        throw new TokenInvalidError('introspection returned 401/403')
      }

      if (response.status >= 500) {
        throw new TokenIntrospectionError(`introspection returned ${response.status}`)
      }

      return this.mapResponse(response.data, rawToken)
    } catch (err) {
      this.rethrowOrWrap(err)
    }
  }

  async refresh(refreshToken: string, currentAccessToken?: string): Promise<TokenPayload> {
    if (!this.refreshUrl) {
      throw new TokenIntrospectionError('no refreshPath configured')
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (currentAccessToken) {
      headers[HTTP_HEADER.AUTHORIZATION] = `${AUTH_SCHEME} ${currentAccessToken}`
    }

    try {
      const response = await axios.post(
        this.refreshUrl,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        {
          timeout: this.config.authTimeoutMs,
          headers,
          validateStatus: () => true,
        }
      )

      if (response.status === 401 || response.status === 403) {
        throw new TokenExpiredError('refresh returned 401/403')
      }

      if (response.status >= 500) {
        throw new TokenIntrospectionError(`refresh returned ${response.status}`)
      }

      return this.mapResponse(response.data, refreshToken)
    } catch (err) {
      this.rethrowOrWrap(err)
    }
  }

  private rethrowOrWrap(err: unknown): never {
    if (err instanceof AuthError) throw err
    throw new TokenIntrospectionError(err instanceof Error ? err.message : String(err))
  }

  private async callAuthService(token: string) {
    if (this.method === 'GET') {
      return axios.get(this.baseUrl, {
        params: { [this.tokenParamName]: token },
        timeout: this.config.authTimeoutMs,
        validateStatus: () => true,
      })
    }

    if (this.tokenPassMode === 'body') {
      return axios.post(this.baseUrl, { [this.tokenParamName]: token }, {
        timeout: this.config.authTimeoutMs,
        headers: { 'Content-Type': CONTENT_TYPE_JSON },
        validateStatus: () => true,
      })
    }

    if (this.tokenPassMode === 'header') {
      return axios.post(this.baseUrl, undefined, {
        headers: { [HTTP_HEADER.AUTHORIZATION]: `${AUTH_SCHEME} ${token}` },
        timeout: this.config.authTimeoutMs,
        validateStatus: () => true,
      })
    }

    return axios.post(this.baseUrl, undefined, {
      params: { [this.tokenParamName]: token },
      timeout: this.config.authTimeoutMs,
      validateStatus: () => true,
    })
  }

  private mapResponse(body: Record<string, unknown>, rawToken: string): TokenPayload {
    const resolve = (path: string | undefined, ...fallbacks: string[]): unknown => {
      if (path) {
        const v = resolveDotPath(body, path)
        if (v !== undefined) return v
      }
      for (const fb of fallbacks) {
        const v = resolveDotPath(body, fb) ?? body[fb]
        if (v !== undefined) return v
      }
      return undefined
    }

    const expiresIn = Number(resolve(this.responseMapping.expires_in, 'expiresIn', 'expires_in'))
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new TokenExpiredError('expires_in <= 0 or invalid in auth response')
    }

    const accessToken = (resolve(this.responseMapping.access_token, 'token', 'access_token') ?? rawToken) as string

    const metadata: Record<string, unknown> = {}
    for (const [key, path] of Object.entries(this.metadataMapping)) {
      const v = resolveDotPath(body, path)
      if (v !== undefined) metadata[key] = v
    }

    const refreshToken = resolve(this.responseMapping.refresh_token, 'refresh_token', 'refreshToken')

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
      scope: (resolve(this.responseMapping.scope, 'scope') ?? '') as string,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }
  }
}

function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function oauthIntrospection(config: OAuthIntrospectionConfig): AuthStrategy {
  return new OAuthIntrospectionStrategy(config)
}

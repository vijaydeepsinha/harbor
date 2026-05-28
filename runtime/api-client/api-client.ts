// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { readFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { setTimeout as sleep } from 'node:timers/promises'
import axios from 'axios'
import type { AxiosInstance } from 'axios'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import type { IdempotencyStrategy } from '../../core/types/idempotency.types.js'
import type { ServiceDefinition } from '../registry/filesystem-scanner.js'
import type { Logger } from '../observability/logger.js'
import type { ConnectorAPI } from '../../spi/connector/connector-api.js'
import {
  ERR,
  HTTP_HEADER,
  CONTENT_TYPE_JSON,
  AUTH_SCHEME,
  MCP_FRAMEWORK_VERSION,
  TOOL,
  LOG_PREFIX
} from '../../core/constants.js'
import { ensureError } from '../../core/utils/errors.js'
import { normalizeEndpointPath, joinUrl } from '../../core/utils/url.js'

// Re-exported for consumers that imported these types from this module directly.
export type { ApiRequest, ApiResponse, ExecuteRequestContext } from '../../spi/connector/connector-api.js'
import type { ApiRequest, ApiResponse, ExecuteRequestContext } from '../../spi/connector/connector-api.js'

export class ApiError extends Error {
  readonly code = ERR.API_ERROR
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable: boolean = false
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiClientContext {
  serviceName: string
  agentName: string
}

export class ApiClient implements ConnectorAPI {
  private readonly axiosInstance: AxiosInstance

  constructor(
    private readonly baseUrl: string,
    private readonly apiConfig: ServiceDefinition['apiConfig'],
    private readonly circuitBreaker: CircuitBreakerStrategy,
    private readonly idempotency: IdempotencyStrategy,
    private readonly logger: Logger,
    private readonly context: ApiClientContext
  ) {
    const httpsAgent = apiConfig.tls
      ? new HttpsAgent({
          cert: readFileSync(apiConfig.tls.certPath),
          key: readFileSync(apiConfig.tls.keyPath),
          ca: readFileSync(apiConfig.tls.caPath)
        })
      : undefined

    this.axiosInstance = axios.create({
      baseURL: baseUrl,
      timeout: apiConfig.requestTimeoutMs,
      httpsAgent,
      validateStatus: () => true
    })
  }

  async request(
    apiRequest: ApiRequest,
    ctx: ExecuteRequestContext
  ): Promise<ApiResponse> {
    return this.idempotency.checkAndExecute(
      ctx.idempotencyKey,
      () => this.executeRequest(apiRequest, ctx),
      ctx.idempotencyKeyTtlMs
    )
  }

  async executeRequest(apiRequest: ApiRequest, ctx: ExecuteRequestContext): Promise<ApiResponse> {
    const { tokenPayload, invalidate, idempotencyKey, correlationId, sessionId, signal } = ctx
    const { path: apiPath, method, params, body } = apiRequest
    const normalizedPath = normalizeEndpointPath(apiPath)

    const headers: Record<string, string> = {
      [HTTP_HEADER.AUTHORIZATION]: `${AUTH_SCHEME} ${tokenPayload.access_token}`,
      [HTTP_HEADER.CORRELATION_ID]: correlationId,
      [HTTP_HEADER.REQUEST_SOURCE]: this.context.agentName,
      [HTTP_HEADER.MCP_TOOL]: TOOL.API_EXECUTE,
      [HTTP_HEADER.MCP_SERVICE]: this.context.serviceName,
      [HTTP_HEADER.MCP_VERSION]: MCP_FRAMEWORK_VERSION,
      [HTTP_HEADER.SESSION_ID]: sessionId,
      [HTTP_HEADER.IDEMPOTENCY_KEY]: idempotencyKey,
      [HTTP_HEADER.CONTENT_TYPE]: CONTENT_TYPE_JSON,
      ...apiRequest.headers
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= this.apiConfig.maxRetries; attempt++) {
      try {
        this.logger.debug(
          {
            step: 'http-request',
            attempt: attempt + 1,
            method,
            url: joinUrl(this.baseUrl, apiPath),
            params,
            correlationId
          },
          `${LOG_PREFIX.API_OUT} ${method} ${apiPath}`
        )

        const response = await this.axiosInstance.request({
          method,
          url: apiPath,
          params,
          data: body,
          headers,
          signal
        })

        this.logger.info(
          {
            step: 'http-response',
            method,
            path: apiPath,
            status: response.status,
            ok: response.status >= 200 && response.status < 400,
            correlationId
          },
          `${LOG_PREFIX.API_IN} ${response.status} ${method} ${apiPath}`
        )

        if (response.status >= 200 && response.status < 400) {
          return { data: response.data, status: response.status, ok: true }
        }

        if (response.status >= 400 && response.status < 500) {
          if (response.status === 401) {
            this.logger.info(
              { step: 'token-invalidated', method, path: apiPath, correlationId },
              `${LOG_PREFIX.API_IN} backend rejected token — invalidating cache`
            )
            try {
              await invalidate()
            } catch (err) {
              this.logger.warn(
                { correlationId, error: ensureError(err).message },
                'Token cache invalidation failed'
              )
            }
          }
          return { data: response.data, status: response.status, ok: false }
        }

        // 5xx — service failure
        this.circuitBreaker.recordFailure(normalizedPath)
        lastError = new ApiError(
          `Upstream API returned ${response.status}`,
          response.status,
          true
        )

        if (attempt < this.apiConfig.maxRetries) {
          await sleep(backoffMs(attempt))
        }
      } catch (err) {
        // Sandbox disposed — not a backend failure; skip CB recording and retries.
        if (signal?.aborted) throw ensureError(err)
        this.circuitBreaker.recordFailure(normalizedPath)
        lastError = ensureError(err)

        if (attempt < this.apiConfig.maxRetries) {
          await sleep(backoffMs(attempt))
        }
      }
    }

    throw lastError ?? new ApiError('Unknown API error')
  }
}

/**
 * Exponential backoff with jitter: 500ms * 2^attempt + [0..500)ms. Attempts
 * are 0-indexed, so the first retry waits ~500–1000ms, the second ~1–1.5s,
 * etc. The random component desynchronises retries across callers so a
 * temporary upstream hiccup doesn't turn into a synchronised retry storm.
 */
function backoffMs(attempt: number): number {
  const base = 500 * Math.pow(2, attempt)
  return base + Math.random() * 500
}

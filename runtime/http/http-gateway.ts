// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { extractBearerFromRequest, bearerFailureToHttpResponse } from '../../spi/auth/bearer-authorization.js'
import { handleProtectedResourceMetadata } from './oauth-metadata-handler.js'
import { sendJson, sendGatewayError } from './send-response.js'
import { HttpError } from './http-error.js'
import { ERR, HTTP_ROUTES } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'

export interface HttpGatewayOptions {
  host: string
  port: number
  createMcpServer: (clientToken: string) => McpServer
  registry: ServiceRegistry
  logger: Logger
  oauthConfig?: OAuthResourceConfig
}

export interface HttpGatewayHandle {
  /** The underlying Node `http.Server`, exposed so the caller can close it on shutdown. */
  server: Server
}

/**
 * Creates and starts the Streamable-HTTP MCP gateway.
 *
 * This module owns the HTTP surface end-to-end: routing, bearer-auth
 * extraction, and stateless per-request MCP transport handling. The boot
 * logic in `server-factory.ts` depends only on the returned handle — it does
 * not need to know about `node:http` or the SDK transport.
 */
export function startHttpGateway(opts: HttpGatewayOptions): HttpGatewayHandle {
  const { host, port, createMcpServer, registry, logger, oauthConfig } = opts

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/'

      if (url === HTTP_ROUTES.HEALTH) {
        sendJson(res, 200, {
          status: 'ok',
          services: registry.serviceNames()
        })
        return
      }

      if (
        url === HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE ||
        url === HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE_MCP
      ) {
        if (oauthConfig) {
          handleProtectedResourceMetadata(res, oauthConfig)
        } else {
          throw new HttpError(404, ERR.NOT_FOUND, 'Not found', undefined, { url })
        }
        return
      }

      if (url === HTTP_ROUTES.MCP) {
        await handleAuthenticatedMcpRequest(req, res, createMcpServer, logger, oauthConfig)
        return
      }

      throw new HttpError(404, ERR.NOT_FOUND, 'Not found', undefined, { url })
    } catch (err) {
      if (res.headersSent) {
        // Transport already owns the response stream — best we can do is end it
        // and log. Typed-error serialization would corrupt a partial body.
        logger.error(
          { url: req.url, method: req.method, error: errorMessage(err) },
          'Unhandled error after response started'
        )
        res.end()
        return
      }

      if (err instanceof HttpError) {
        const logPayload = { url: req.url, method: req.method, code: err.code, ...err.logContext }
        if (err.status >= 500) {
          logger.error({ ...logPayload, error: err.message }, err.message)
        } else {
          logger.warn(logPayload, err.message)
        }
        sendJson(res, err.status, { error: err.message, code: err.code, ...err.body }, err.headers)
        return
      }

      logger.error(
        { url: req.url, method: req.method, error: errorMessage(err) },
        'Unhandled error in HTTP handler'
      )
      sendGatewayError(res, 500, ERR.INTERNAL, 'Internal server error')
    }
  })

  server.listen(port, host, () => {
    logger.info(
      {
        endpoint: `http://${host}:${port}${HTTP_ROUTES.MCP}`,
        health: `http://${host}:${port}${HTTP_ROUTES.HEALTH}`,
        services: registry.serviceNames()
      },
      '🚀 Harbor ready (Streamable HTTP) — waiting for Clients to connect'
    )
  })

  return { server }
}

/**
 * Handles a request on the `/mcp` route using a fresh stateless transport and
 * McpServer per HTTP request (`sessionIdGenerator: undefined`).
 *
 * Auth failures throw {@link HttpError}; only the transport itself owns the
 * response stream on the happy path.
 */
async function handleAuthenticatedMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  createMcpServer: (clientToken: string) => McpServer,
  logger: Logger,
  oauthConfig?: OAuthResourceConfig
): Promise<void> {
  const extracted = extractBearerFromRequest(req)
  if (!extracted.ok) {
    const resourceMetadataUrl = oauthConfig
      ? `${oauthConfig.resourceUri}${HTTP_ROUTES.OAUTH_PROTECTED_RESOURCE}`
      : undefined
    const { status, body, headers } = bearerFailureToHttpResponse(extracted.error, extracted.reason, resourceMetadataUrl)
    throw new HttpError(status, extracted.error.code, body.error, { reason: body.reason }, { reason: extracted.reason }, headers)
  }

  const clientToken = extracted.token
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  })
  let mcpServer: McpServer | undefined

  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    void transport.close?.().catch((err) => {
      logger.warn({ error: errorMessage(err) }, 'Stateless transport close failed')
    })
    void mcpServer?.close().catch((err) => {
      logger.warn({ error: errorMessage(err) }, 'Stateless McpServer close failed')
    })
  }

  res.on('close', cleanup)

  try {
    mcpServer = createMcpServer(clientToken)
    await mcpServer.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    cleanup()
    throw err
  }
}

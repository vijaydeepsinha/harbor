// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { extractBearerFromRequest, bearerFailureToHttpResponse } from '../../spi/auth/bearer-authorization.js'
import { handleProtectedResourceMetadata } from './oauth-metadata-handler.js'
import { sendJson, sendGatewayError } from './send-response.js'
import { HttpError } from './http-error.js'
import { ERR, HTTP_ROUTES } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'
import type { McpServerFactory } from './mcp-server-factory.js'

/** Node request with pass-through auth for {@linkcode toNodeHandler}. */
type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo }

export interface HttpGatewayOptions {
  host: string
  port: number
  createMcpServer: McpServerFactory
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
 * extraction, and stateless per-request MCP handler dispatch via the SDK v2
 * `createMcpHandler` entry (`legacy: 'reject'` — 2026-07-28 only). The boot
 * logic in `server-factory.ts` depends only on the returned handle — it does
 * not need to know about `node:http` or transport wiring.
 */
export function startHttpGateway(opts: HttpGatewayOptions): HttpGatewayHandle {
  const { host, port, createMcpServer, registry, logger, oauthConfig } = opts

  const mcpHandler = createMcpHandler(createMcpServer, { legacy: 'reject' })
  const nodeMcpHandler = toNodeHandler(mcpHandler)

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
        await handleAuthenticatedMcpRequest(req, res, nodeMcpHandler, logger, oauthConfig)
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
      '🚀 Harbor ready (Streamable HTTP, MCP 2026-07-28) — waiting for Clients to connect'
    )
  })

  return { server }
}

/**
 * Validates bearer auth, attaches pass-through {@link AuthInfo} on the Node
 * request (consumed by {@linkcode toNodeHandler}), and delegates to the MCP
 * handler. Auth failures throw {@link HttpError}; the MCP handler owns the
 * response stream on the happy path.
 */
async function handleAuthenticatedMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  nodeMcpHandler: NodeMcpRequestHandler,
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

  const authReq = req as AuthenticatedIncomingMessage
  authReq.auth = {
    token: extracted.token,
    clientId: 'harbor-client',
    scopes: []
  }

  try {
    await nodeMcpHandler(authReq, res)
  } catch (err) {
    logger.warn({ error: errorMessage(err) }, 'MCP handler dispatch failed')
    throw err
  }
}

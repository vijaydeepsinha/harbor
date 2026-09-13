// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, UnsupportedProtocolVersionError, type AuthInfo } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { OAuthResourceConfig } from '../../core/types/oauth.types.js'
import { extractBearerFromRequest, bearerFailureToHttpResponse } from '../../spi/auth/bearer-authorization.js'
import { handleProtectedResourceMetadata } from './oauth-metadata-handler.js'
import { readMcpRequestIdentity } from './mcp-request-identity.js'
import { sendJson, sendGatewayError } from './send-response.js'
import { HttpError } from './http-error.js'
import { ERR, HTTP_ROUTES, MCP_PROTOCOL_VERSION } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'
import type { GatewayMcpServerFactory } from './mcp-server-factory.js'

/** Node request with pass-through auth for {@linkcode toNodeHandler}. */
type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo }

/**
 * Placeholder `AuthInfo.clientId` for every request. Harbor's current bearer
 * auth flow does not derive a real per-principal client id or scopes from the
 * token — the SDK's `AuthInfo` type documents these as carrying real
 * per-principal semantics, so this sentinel is named and commented explicitly
 * (rather than a bare literal) to stay grep-able as a known placeholder
 * pending real per-principal `clientId`/`scopes` derivation (e.g. from token
 * introspection/claims).
 */
const UNSCOPED_CLIENT_ID = 'harbor-client' as const

export interface HttpGatewayOptions {
  host: string
  port: number
  createMcpServer: GatewayMcpServerFactory
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

  // Both `createMcpHandler` and `toNodeHandler` catch every failure internally
  // and always resolve/write a response — neither one ever throws back to the
  // caller. `onerror` is the SDK's only hook for observing these failures
  // (including a legacy-protocol client hitting `legacy: 'reject'`), so it is
  // the sole mechanism for the operator-visible signal below; a try/catch
  // around the handler call cannot observe them.
  const mcpHandler = createMcpHandler(createMcpServer, {
    legacy: 'reject',
    onerror: (error) => {
      if (error instanceof UnsupportedProtocolVersionError) {
        logger.warn({ event: 'legacy_client_rejected', error: errorMessage(error) }, 'MCP handler dispatch failed')
      } else {
        logger.warn({ error: errorMessage(error) }, 'MCP handler dispatch failed')
      }
    }
  })
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      logger.error({ error: errorMessage(error) }, 'MCP node adapter error before response written')
    }
  })

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? '/'

      if (url === HTTP_ROUTES.HEALTH) {
        sendJson(res, 200, {
          status: 'ok',
          // Single protocol version Harbor speaks (spec §20). Harbor rejects
          // legacy clients at the transport (`legacy: 'reject'`); this makes
          // the supported version explicit for operators and monitoring.
          protocolVersion: MCP_PROTOCOL_VERSION,
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
    clientId: UNSCOPED_CLIENT_ID,
    scopes: [] as string[] /* not yet derived from auth flow */
  }

  // Normalized MCP request identity from HTTP headers (spec §14) — advisory:
  // routing and observability only, never auth (the SDK validates/reconciles
  // these headers against the JSON-RPC body itself).
  logger.debug({ ...readMcpRequestIdentity(req.headers) }, 'Dispatching MCP request')

  // `nodeMcpHandler` (built from `createMcpHandler` + `toNodeHandler`) catches
  // every internal failure itself and always writes a response — it does not
  // throw. Dispatch failures, including a legacy-protocol client rejection,
  // are observed via the `onerror` hooks passed to those two factories above,
  // not via a try/catch here.
  await nodeMcpHandler(authReq, res)
}

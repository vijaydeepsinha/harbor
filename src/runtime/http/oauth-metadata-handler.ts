// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ServerResponse } from 'node:http'
import type { OAuthResourceConfig, ProtectedResourceMetadata } from '../../core/types/oauth.types.js'
import { sendJson } from './send-response.js'

export function handleProtectedResourceMetadata(res: ServerResponse, oauth: OAuthResourceConfig): void {
  const doc: ProtectedResourceMetadata = {
    resource: oauth.resourceUri,
    authorization_servers: oauth.authorizationServers,
    bearer_methods_supported: ['header'],
    ...(oauth.scopesSupported?.length ? { scopes_supported: oauth.scopesSupported } : {})
  }
  sendJson(res, 200, doc)
}

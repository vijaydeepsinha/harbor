// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
  bearer_methods_supported: ['header']
}

export interface OAuthResourceConfig {
  resourceUri: string
  authorizationServers: string[]
  scopesSupported?: string[]
}

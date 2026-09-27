// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ApiRequest, ApiResponse, ExecuteRequestContext } from '../../core/types/connector.types.js'

export type { ApiRequest, ApiResponse, ExecuteRequestContext }

/**
 * Outbound transport contract for skill code execution.
 *
 * `api.request()` inside the V8 sandbox delegates to this interface.
 * The default implementation is HttpConnectorAPI (wraps ApiClient / axios).
 * Implement this interface to proxy skills to gRPC, GraphQL, or any other
 * backend transport without modifying sandbox code.
 */
export interface ConnectorAPI {
  request(
    apiRequest: ApiRequest,
    ctx: ExecuteRequestContext
  ): Promise<ApiResponse>
}

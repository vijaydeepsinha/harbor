// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { OpenAPISpec } from './spec.types.js'
import type { TokenPayload } from './auth.types.js'
import { ERR, type AllowedHttpMethod } from '../constants.js'

export interface PermissionGuard {
  filterSpec(spec: OpenAPISpec, token: TokenPayload): OpenAPISpec
  canExecute(endpoint: string, method: AllowedHttpMethod, token: TokenPayload): boolean
}

export class PermissionDeniedError extends Error {
  readonly code = ERR.PERMISSION_DENIED
  readonly retryable = false
  constructor(endpoint: string, method: AllowedHttpMethod) {
    super(
      `Permission denied for ${method} ${endpoint}. ` +
      `Your token scope does not permit this operation.`
    )
    this.name = 'PermissionDeniedError'
  }
}

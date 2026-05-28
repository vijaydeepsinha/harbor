// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { PermissionGuard } from '../../../core/types/permission.types.js'
import type { OpenAPISpec } from '../../../core/types/spec.types.js'
import type { TokenPayload } from '../../../core/types/auth.types.js'
import type { AllowedHttpMethod } from '../../../core/constants.js'

export class ForwardTokenPermissionGuardStrategy implements PermissionGuard {
  filterSpec(spec: OpenAPISpec, _token: TokenPayload): OpenAPISpec {
    return spec
  }

  canExecute(_endpoint: string, _method: AllowedHttpMethod, _token: TokenPayload): boolean {
    return true
  }
}

export function forwardTokenPermissionGuard(): PermissionGuard {
  return new ForwardTokenPermissionGuardStrategy()
}

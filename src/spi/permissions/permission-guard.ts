// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {OpenAPISpec} from '../../core/types/spec.types.js'
import type {TokenPayload} from '../../core/types/auth.types.js'
import type {AllowedHttpMethod} from '../../core/constants.js'

export interface PermissionGuard {
    filterSpec(spec: OpenAPISpec, token: TokenPayload): OpenAPISpec

    canExecute(endpoint: string, method: AllowedHttpMethod, token: TokenPayload): boolean
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {type AllowedHttpMethod, ERR} from '../constants.js'

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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {OpenAPISpec} from '../../core/types/spec.types.js'

export interface SpecLoaderStrategy {
    readonly name: string

    load(): Promise<OpenAPISpec>
}

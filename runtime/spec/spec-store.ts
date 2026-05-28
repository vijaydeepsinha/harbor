// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { OpenAPISpec } from '../../core/types/spec.types.js'

export class SpecStore {
  private current: OpenAPISpec | null = null

  getSpec(): OpenAPISpec {
    if (this.current === null) {
      throw new Error('Spec not yet loaded. Call swap() with an initial spec before getSpec().')
    }
    return this.current
  }

  swap(newSpec: OpenAPISpec): void {
    this.current = newSpec
  }
}

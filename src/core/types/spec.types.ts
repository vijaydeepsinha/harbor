// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Minimal structural shape every spec loader must return. Keeps `openapi` /
 * `info.title` / `info.version` statically enforced so downstream code
 * (filesystem-scanner, ServiceRefresher, tools/discover-services) can trust
 * those fields without re-validating. Everything else stays `unknown` so we
 * don't lock ourselves to a specific OpenAPI minor version.
 */
export interface OpenAPISpec {
  openapi: string
  info: {
    title: string
    version: string
    description?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

export interface SpecLoaderStrategy {
  readonly name: string
  load(): Promise<OpenAPISpec>
}

export class SpecLoadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'SpecLoadError'
  }
}

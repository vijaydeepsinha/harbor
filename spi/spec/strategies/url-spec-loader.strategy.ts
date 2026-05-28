// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import axios from 'axios'
import SwaggerParser from '@apidevtools/swagger-parser'
import yaml from 'js-yaml'
import type { SpecLoaderStrategy, OpenAPISpec } from '../../../core/types/spec.types.js'
import { SpecLoadError } from '../../../core/types/spec.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { errorMessage } from '../../../core/utils/errors.js'

export class UrlSpecLoaderStrategy implements SpecLoaderStrategy {
  readonly name = 'url-spec-loader'

  constructor(
    private readonly url: string,
    private readonly fetchTimeoutMs: number = 10_000,
    private readonly logger?: Logger
  ) {}

  async load(): Promise<OpenAPISpec> {
    try {
      const response = await axios.get(this.url, {
        timeout: this.fetchTimeoutMs,
        responseType: 'text'
      })

      const contentType: string = (response.headers['content-type'] as string | undefined) ?? ''
      let parsed: unknown

      if (contentType.includes('yaml') || contentType.includes('yml')) {
        parsed = yaml.load(response.data as string)
      } else {
        try {
          parsed = JSON.parse(response.data as string)
        } catch {
          parsed = yaml.load(response.data as string)
        }
      }

      const dereferenced = await SwaggerParser.dereference(parsed as Parameters<typeof SwaggerParser.dereference>[0])
      this.logger?.debug({ url: this.url }, 'URL spec loaded')
      return dereferenced as OpenAPISpec
    } catch (err) {
      if (err instanceof SpecLoadError) throw err
      this.logger?.warn({ url: this.url, error: errorMessage(err) }, 'URL spec load failed')
      throw new SpecLoadError(
        `Failed to load spec from URL "${this.url}": ${errorMessage(err)}`,
        err
      )
    }
  }
}

export function urlSpec(
  url: string,
  fetchTimeoutMs?: number,
  logger?: Logger
): SpecLoaderStrategy {
  return new UrlSpecLoaderStrategy(url, fetchTimeoutMs, logger)
}

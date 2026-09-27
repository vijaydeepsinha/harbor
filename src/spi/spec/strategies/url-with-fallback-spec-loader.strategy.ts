// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { SpecLoaderStrategy, OpenAPISpec } from '../../../core/types/spec.types.js'
import { SpecLoadError } from '../../../core/types/spec.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { errorMessage } from '../../../core/utils/errors.js'
import { urlSpec } from './url-spec-loader.strategy.js'
import { fileSpec } from './file-spec-loader.strategy.js'

export class UrlWithFallbackSpecLoaderStrategy implements SpecLoaderStrategy {
  readonly name = 'url-with-fallback-spec-loader'

  private readonly urlLoader: SpecLoaderStrategy
  private readonly fileLoader: SpecLoaderStrategy

  constructor(
    private readonly url: string,
    private readonly filePath: string,
    private readonly fetchTimeoutMs?: number,
    private readonly logger?: Logger
  ) {
    this.urlLoader = urlSpec(url, fetchTimeoutMs, logger)
    this.fileLoader = fileSpec(filePath)
  }

  async load(): Promise<OpenAPISpec> {
    let urlError: string | undefined
    try {
      return await this.urlLoader.load()
    } catch (err) {
      urlError = errorMessage(err)
      this.logger?.info(
        { url: this.url, filePath: this.filePath, cause: urlError },
        'Using file fallback for spec'
      )
    }

    try {
      return await this.fileLoader.load()
    } catch (fileErr) {
      const fileError = fileErr instanceof Error ? fileErr.message : String(fileErr)
      throw new SpecLoadError(
        `Both URL and file spec loads failed.\n` +
        `  URL (${this.url}): ${urlError}\n` +
        `  File (${this.filePath}): ${fileError}`,
        { urlError, fileError }
      )
    }
  }
}

export function urlWithFallback(
  url: string,
  filePath: string,
  fetchTimeoutMs?: number,
  logger?: Logger
): SpecLoaderStrategy {
  return new UrlWithFallbackSpecLoaderStrategy(url, filePath, fetchTimeoutMs, logger)
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SpecLoaderStrategy, OpenAPISpec } from '../../core/types/spec.types.js'
import { SpecLoadError } from '../../core/types/spec.types.js'

const urlLoadMock = vi.fn<[], Promise<OpenAPISpec>>()
const fileLoadMock = vi.fn<[], Promise<OpenAPISpec>>()

vi.mock('../../spi/spec/strategies/url-spec-loader.strategy.js', () => ({
  urlSpec: (): SpecLoaderStrategy => ({ name: 'url-spec-loader', load: urlLoadMock })
}))

vi.mock('../../spi/spec/strategies/file-spec-loader.strategy.js', () => ({
  fileSpec: (): SpecLoaderStrategy => ({ name: 'file-spec-loader', load: fileLoadMock })
}))

const { UrlWithFallbackSpecLoaderStrategy, urlWithFallback } =
  await import('../../spi/spec/strategies/url-with-fallback-spec-loader.strategy.js')

function spec(): OpenAPISpec {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1.0.0' }
  }
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn() }
}

describe('UrlWithFallbackSpecLoaderStrategy', () => {
  beforeEach(() => {
    urlLoadMock.mockReset()
    fileLoadMock.mockReset()
  })

  it('returns the URL result when the URL loader succeeds — file loader is never called', async () => {
    const s = spec()
    urlLoadMock.mockResolvedValueOnce(s)

    const loader = new UrlWithFallbackSpecLoaderStrategy('https://example.com/spec', '/tmp/fallback.yaml')
    await expect(loader.load()).resolves.toBe(s)

    expect(urlLoadMock).toHaveBeenCalledOnce()
    expect(fileLoadMock).not.toHaveBeenCalled()
  })

  it('falls back to file and logs an info with the URL cause when the URL loader fails', async () => {
    const s = spec()
    urlLoadMock.mockRejectedValueOnce(new Error('network down'))
    fileLoadMock.mockResolvedValueOnce(s)

    const logger = fakeLogger()
    const loader = urlWithFallback(
      'https://example.com/spec',
      '/tmp/fallback.yaml',
      undefined,
      logger as unknown as Parameters<typeof urlWithFallback>[3]
    )
    await expect(loader.load()).resolves.toBe(s)

    expect(urlLoadMock).toHaveBeenCalledOnce()
    expect(fileLoadMock).toHaveBeenCalledOnce()
    expect(logger.info).toHaveBeenCalledOnce()
    const [payload, msg] = logger.info.mock.calls[0]!
    expect(payload).toMatchObject({
      url: 'https://example.com/spec',
      filePath: '/tmp/fallback.yaml',
      cause: 'network down'
    })
    expect(msg).toContain('file fallback')
  })

  it('throws SpecLoadError with both causes when both loaders fail', async () => {
    urlLoadMock.mockRejectedValueOnce(new Error('network down'))
    fileLoadMock.mockRejectedValueOnce(new Error('ENOENT: no such file'))

    const loader = new UrlWithFallbackSpecLoaderStrategy('https://example.com/spec', '/tmp/fallback.yaml')
    let thrown: unknown
    try {
      await loader.load()
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(SpecLoadError)
    const typed = thrown as SpecLoadError
    expect(typed.message).toContain('network down')
    expect(typed.message).toContain('ENOENT')
    expect(typed.cause).toEqual({ urlError: 'network down', fileError: 'ENOENT: no such file' })
  })
})

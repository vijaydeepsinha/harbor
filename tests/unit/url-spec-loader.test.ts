// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { UrlSpecLoaderStrategy, urlSpec } from '../../spi/spec/strategies/url-spec-loader.strategy.js'
import { SpecLoadError } from '../../core/types/spec.types.js'
import type { Logger } from '../../runtime/observability/logger.js'

vi.mock('axios')

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn()
  }
}

describe('UrlSpecLoaderStrategy', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset()
  })

  it('warns with {url, error} before wrapping the failure into SpecLoadError', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.1:443'))
    const logger = fakeLogger()

    const loader = new UrlSpecLoaderStrategy(
      'https://specs.example.com/openapi.yaml',
      5_000,
      logger as unknown as Logger
    )

    await expect(loader.load()).rejects.toBeInstanceOf(SpecLoadError)

    expect(logger.warn).toHaveBeenCalledOnce()
    const [payload, msg] = logger.warn.mock.calls[0]!
    expect(payload).toMatchObject({
      url: 'https://specs.example.com/openapi.yaml',
      error: 'ECONNREFUSED 10.0.0.1:443'
    })
    expect(msg).toBe('URL spec load failed')
  })

  it('does not log a warn on the happy path', async () => {
    const validSpec = {
      openapi: '3.0.0',
      info: { title: 't', version: '1.0.0' },
      paths: {}
    }
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: JSON.stringify(validSpec),
      headers: { 'content-type': 'application/json' }
    })
    const logger = fakeLogger()

    const loader = urlSpec(
      'https://specs.example.com/openapi.json',
      5_000,
      logger as unknown as Logger
    )
    await loader.load()

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('logger is optional — no-throw when omitted on failure', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('boom'))
    const loader = urlSpec('https://specs.example.com/openapi.yaml')
    await expect(loader.load()).rejects.toBeInstanceOf(SpecLoadError)
  })
})

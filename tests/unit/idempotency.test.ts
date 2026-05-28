// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryIdempotencyStrategy } from '../../adapters/idempotency/strategies/in-memory-idempotency.strategy.js'
import { NoopIdempotencyStrategy } from '../../spi/idempotency/strategies/noop-idempotency.strategy.js'
import { MemcacheIdempotencyStrategy } from '../../adapters/idempotency/strategies/memcache-idempotency.strategy.js'
import { CouchbaseIdempotencyStrategy } from '../../adapters/idempotency/strategies/couchbase-idempotency.strategy.js'
import axios from 'axios'

vi.mock('axios')
vi.mock('memjs', () => ({
  default: {
    Client: {
      create: vi.fn(() => ({
        get: vi.fn(),
        set: vi.fn()
      }))
    }
  }
}))

const TTL = 60_000

describe('InMemoryIdempotencyStrategy', () => {
  let strategy: InMemoryIdempotencyStrategy

  beforeEach(() => {
    strategy = new InMemoryIdempotencyStrategy()
  })

  it('first call executes fn and caches result', async () => {
    const fn = vi.fn().mockResolvedValue({ data: 'result' })
    const result = await strategy.checkAndExecute('key1', fn, TTL)
    expect(fn).toHaveBeenCalledOnce()
    expect(result).toEqual({ data: 'result' })
  })

  it('duplicate key within TTL returns cache without re-executing', async () => {
    const fn = vi.fn().mockResolvedValue('cached-result')
    await strategy.checkAndExecute('key1', fn, TTL)
    const result = await strategy.checkAndExecute('key1', fn, TTL)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(result).toBe('cached-result')
  })

  it('expired entry re-executes fn', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    const fn = vi.fn().mockResolvedValue('fresh-result')
    await strategy.checkAndExecute('key1', fn, 1000) // TTL = 1 second

    vi.setSystemTime(now + 2000) // advance past TTL
    await strategy.checkAndExecute('key1', fn, 1000)

    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('idempotencyKeyTtlMs is passed per call, not per construction', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)

    const fn = vi.fn().mockResolvedValue('result')
    await strategy.checkAndExecute('key1', fn, 500) // 500ms TTL

    vi.setSystemTime(now + 600)
    await strategy.checkAndExecute('key1', fn, 500)

    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('generateKey produces unique keys for different users', () => {
    const key1 = strategy.generateKey('user-hash-aaa')
    const key2 = strategy.generateKey('user-hash-bbb')
    expect(key1).not.toBe(key2)
    expect(key1).toContain('user-hash-aaa')
    expect(key2).toContain('user-hash-bbb')
  })

  it('concurrent callers with same key share a single execution', async () => {
    let resolveFn: (v: string) => void
    const pending = new Promise<string>((r) => { resolveFn = r })
    const fn = vi.fn().mockImplementationOnce(() => pending)

    const [a, b, c] = [
      strategy.checkAndExecute('key1', fn, TTL),
      strategy.checkAndExecute('key1', fn, TTL),
      strategy.checkAndExecute('key1', fn, TTL)
    ]
    resolveFn!('only-once')

    await expect(a).resolves.toBe('only-once')
    await expect(b).resolves.toBe('only-once')
    await expect(c).resolves.toBe('only-once')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('failure while pending evicts the sentinel so retries re-execute', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok')

    await expect(strategy.checkAndExecute('key1', fn, TTL)).rejects.toThrow('boom')
    await expect(strategy.checkAndExecute('key1', fn, TTL)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('logs a warn with {key, error} before rethrowing on pending-fn failure', async () => {
    const warn = vi.fn()
    const logger = {
      info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child: () => logger
    } as unknown as import('../../runtime/observability/logger.js').Logger
    const loggedStrategy = new InMemoryIdempotencyStrategy(logger)

    const fn = vi.fn().mockRejectedValue(new Error('backend kaboom'))
    await expect(loggedStrategy.checkAndExecute('k-log', fn, TTL)).rejects.toThrow('backend kaboom')

    expect(warn).toHaveBeenCalledTimes(1)
    const [payload, message] = warn.mock.calls[0]
    expect(payload).toEqual({ key: 'k-log', error: 'backend kaboom' })
    expect(message).toMatch(/Idempotency execution failed/)
  })

  it('works without a logger (logger is optional)', async () => {
    const loggerless = new InMemoryIdempotencyStrategy()
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(loggerless.checkAndExecute('k', fn, TTL)).rejects.toThrow('boom')
  })
})

describe('NoopIdempotencyStrategy', () => {
  let strategy: NoopIdempotencyStrategy

  beforeEach(() => {
    strategy = new NoopIdempotencyStrategy()
  })

  it('always executes fn regardless of key', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    await strategy.checkAndExecute('key1', fn, TTL)
    await strategy.checkAndExecute('key1', fn, TTL)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('MemcacheIdempotencyStrategy', () => {
  it('cache hit returns cached value (mocked memjs)', async () => {
    const memjs = await import('memjs')
    const mockClient = {
      get: vi.fn().mockResolvedValue({ value: Buffer.from(JSON.stringify({ cached: true })) }),
      set: vi.fn().mockResolvedValue(true)
    }
    vi.mocked(memjs.default.Client.create).mockReturnValue(mockClient as never)

    const strategy = new MemcacheIdempotencyStrategy({
      host: 'localhost', port: 11211, kvTimeoutMs: 2000
    })

    const fn = vi.fn().mockResolvedValue({ cached: false })
    const result = await strategy.checkAndExecute('key1', fn, TTL)

    expect(fn).not.toHaveBeenCalled()
    expect(result).toEqual({ cached: true })
  })

  it('cache read failure falls through to fn() and still attempts write', async () => {
    const memjs = await import('memjs')
    const mockClient = {
      get: vi.fn().mockRejectedValue(new Error('Connection refused')),
      set: vi.fn().mockResolvedValue(true)
    }
    vi.mocked(memjs.default.Client.create).mockReturnValue(mockClient as never)

    const strategy = new MemcacheIdempotencyStrategy({
      host: 'localhost', port: 11211, kvTimeoutMs: 2000
    })

    const fn = vi.fn().mockResolvedValue('fallthrough-result')
    const result = await strategy.checkAndExecute('key1', fn, TTL)

    expect(fn).toHaveBeenCalledOnce()
    expect(result).toBe('fallthrough-result')
    // Matches Couchbase semantics: even if the read failed we still try to
    // populate the cache so subsequent callers can hit.
    expect(mockClient.set).toHaveBeenCalledOnce()
  })
})

describe('CouchbaseIdempotencyStrategy', () => {
  const config = {
    host: 'localhost', port: 8093, bucket: 'test',
    username: 'user', password: 'pass', kvTimeoutMs: 3000
  }

  it('GET 200 returns cached result (mocked axios)', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { json: JSON.stringify({ cached: true }) }
    })

    const strategy = new CouchbaseIdempotencyStrategy(config)
    const fn = vi.fn().mockResolvedValue({ cached: false })
    const result = await strategy.checkAndExecute('key1', fn, TTL)

    expect(fn).not.toHaveBeenCalled()
    expect(result).toEqual({ cached: true })
  })

  it('GET 404 executes fn and POSTs result (mocked axios)', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 404, data: {} })
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 201, data: {} })

    const strategy = new CouchbaseIdempotencyStrategy(config)
    const fn = vi.fn().mockResolvedValue({ fresh: true })
    const result = await strategy.checkAndExecute('key1', fn, TTL)

    expect(fn).toHaveBeenCalledOnce()
    expect(axios.post).toHaveBeenCalledOnce()
    expect(result).toEqual({ fresh: true })
  })

  it('HTTP error falls through to fn() silently', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'))

    const strategy = new CouchbaseIdempotencyStrategy(config)
    const fn = vi.fn().mockResolvedValue('fallthrough')
    const result = await strategy.checkAndExecute('key1', fn, TTL)

    expect(fn).toHaveBeenCalledOnce()
    expect(result).toBe('fallthrough')
  })
})

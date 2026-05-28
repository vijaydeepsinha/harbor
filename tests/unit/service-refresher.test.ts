// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceRefresher } from '../../runtime/spec/service-refresher.js'
import { SpecStore } from '../../runtime/spec/spec-store.js'
import { SkillStore } from '../../runtime/registry/skill-store.js'
import type { SpecLoaderStrategy, OpenAPISpec } from '../../core/types/spec.types.js'
import { SpecLoadError } from '../../core/types/spec.types.js'
import pino from 'pino'

const silentLogger = pino({ level: 'silent' })

const refreshConfig = {
  serviceRefreshIntervalMs: 5_000,
  serviceRefreshTimeoutMs: 10_000
}

function makeMockLoader(spec?: OpenAPISpec, throwError?: boolean): SpecLoaderStrategy {
  return {
    name: 'mock',
    load: throwError
      ? vi.fn().mockRejectedValue(new SpecLoadError('Spec load failed'))
      : vi.fn().mockResolvedValue(spec ?? { paths: {} })
  }
}

describe('ServiceRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('forceRefresh refreshes spec via specStore.swap()', async () => {
    const newSpec = { paths: { '/orders': {} } }
    const loader = makeMockLoader(newSpec)
    const specStore = new SpecStore()
    specStore.swap({ paths: {} })
    const skillStore = new SkillStore()

    const swapSpy = vi.spyOn(specStore, 'swap')

    const refresher = new ServiceRefresher(loader, specStore, skillStore, '/tmp/fake-svc', refreshConfig, silentLogger)
    await refresher.forceRefresh()

    expect(swapSpy).toHaveBeenCalledWith(newSpec)
  })

  it('spec load failure keeps existing spec', async () => {
    const loader = makeMockLoader(undefined, true)
    const specStore = new SpecStore()
    const existingSpec = { paths: { '/existing': {} } }
    specStore.swap(existingSpec)
    const skillStore = new SkillStore()

    const swapSpy = vi.spyOn(specStore, 'swap')

    const refresher = new ServiceRefresher(loader, specStore, skillStore, '/tmp/fake-svc', refreshConfig, silentLogger)
    await refresher.forceRefresh()

    expect(swapSpy).not.toHaveBeenCalled()
    expect(specStore.getSpec()).toEqual(existingSpec)
  })

  it('serviceRefreshIntervalMs: 0 schedules no setInterval', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const loader = makeMockLoader()
    const specStore = new SpecStore()
    specStore.swap({})
    const skillStore = new SkillStore()

    const staticConfig = { ...refreshConfig, serviceRefreshIntervalMs: 0 }
    const refresher = new ServiceRefresher(loader, specStore, skillStore, '/tmp/fake-svc', staticConfig, silentLogger)
    refresher.start()

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('stop() clears the scheduled interval', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const loader = makeMockLoader()
    const specStore = new SpecStore()
    specStore.swap({})
    const skillStore = new SkillStore()

    const refresher = new ServiceRefresher(loader, specStore, skillStore, '/tmp/fake-svc', refreshConfig, silentLogger)
    refresher.start()
    refresher.stop()

    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {ServiceRefresher} from '../../src/runtime/spec/service-refresher.js'
import {SpecStore} from '../../src/runtime/spec/spec-store.js'
import {SkillStore} from '../../src/runtime/registry/skill-store.js'
import type {OpenAPISpec} from '../../src/core/types/spec.types.js'
import {SpecLoadError} from '../../src/core/types/spec.types.js'
import type {SpecLoaderStrategy} from '../../src/spi/spec/spec-loader.js'
import pino from 'pino'

const silentLogger = pino({level: 'silent'})

const refreshConfig = {
    serviceRefreshIntervalMs: 5_000,
    serviceRefreshTimeoutMs: 10_000
}

function makeMockLoader(spec?: OpenAPISpec, throwError?: boolean): SpecLoaderStrategy {
    return {
        name: 'mock',
        load: throwError
            ? vi.fn().mockRejectedValue(new SpecLoadError('Spec load failed'))
            : vi.fn().mockResolvedValue(spec ?? {paths: {}})
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
        const newSpec = {paths: {'/orders': {}}}
        const loader = makeMockLoader(newSpec)
        const specStore = new SpecStore()
        specStore.swap({paths: {}})
        const skillStore = new SkillStore()

        const swapSpy = vi.spyOn(specStore, 'swap')

        const refresher = new ServiceRefresher(loader, specStore, skillStore, '/tmp/fake-svc', refreshConfig, silentLogger)
        await refresher.forceRefresh()

        expect(swapSpy).toHaveBeenCalledWith(newSpec)
    })

    it('spec load failure keeps existing spec', async () => {
        const loader = makeMockLoader(undefined, true)
        const specStore = new SpecStore()
        const existingSpec = {paths: {'/existing': {}}}
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

        const staticConfig = {...refreshConfig, serviceRefreshIntervalMs: 0}
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

describe('ServiceRefresher — refreshes never overlap, never land late, and keep spec and skills together', () => {
    it('a slow load is not overtaken: overlapping ticks are skipped, so an older spec never lands after a newer one', async () => {
        const releases: Array<() => void> = []
        let version = 0
        const loader: SpecLoaderStrategy = {
            name: 'slow',
            load: vi.fn(() => {
                const v = ++version
                return new Promise<OpenAPISpec>(resolve => {
                    releases.push(() => resolve({paths: {[`/v${v}`]: {}}}))
                })
            })
        }
        const specStore = new SpecStore()
        const refresher = new ServiceRefresher(loader, specStore, new SkillStore(), '/tmp/fake-svc', refreshConfig, silentLogger)
        const first = refresher.forceRefresh()
        const second = refresher.forceRefresh() // skipped while the first is in flight
        releases.shift()!()
        await Promise.all([first, second])
        expect(loader.load).toHaveBeenCalledTimes(1)
        expect(Object.keys(specStore.getSpec().paths ?? {})).toEqual(['/v1'])
    })

    it('nothing is swapped by a refresh that finishes after stop()', async () => {
        let release!: () => void
        const loader: SpecLoaderStrategy = {
            name: 'slow', load: () => new Promise<OpenAPISpec>(r => {
                release = () => r({paths: {'/late': {}}})
            })
        }
        const specStore = new SpecStore()
        specStore.swap({paths: {'/current': {}}})
        const refresher = new ServiceRefresher(loader, specStore, new SkillStore(), '/tmp/fake-svc', refreshConfig, silentLogger)
        const pending = refresher.forceRefresh()
        refresher.stop()
        release()
        await pending
        expect(Object.keys(specStore.getSpec().paths ?? {})).toEqual(['/current'])
    })

    it('a failed spec load keeps the skills as they were too', async () => {
        const skillStore = new SkillStore()
        skillStore.swap([{id: 's', filename: 's.md', title: 's', tags: [], content: 'x'}])
        const refresher = new ServiceRefresher(makeMockLoader(undefined, true), new SpecStore(), skillStore, '/tmp/definitely-no-skills-here', refreshConfig, silentLogger)
        await refresher.forceRefresh()
        expect(skillStore.getSkills().map(s => s.id)).toEqual(['s'])
    })
})

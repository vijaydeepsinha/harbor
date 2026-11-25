// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {afterEach, describe, expect, it} from 'vitest'
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import pino from 'pino'
import {scanServicesDirectory, scanSkills} from '../../src/runtime/registry/filesystem-scanner.js'
import {buildIdempotencyStrategy} from '../../src/wiring/strategy-builders.js'
import {buildServiceResources} from '../../src/runtime/gateway/service-resources-factory.js'
import {InMemoryTokenCache} from '../../src/adapters/auth/strategies/in-memory-token-cache.strategy.js'
import {globalConfig} from './code-mode-harness.js'

const silent = pino({level: 'silent'})
const SPEC = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n'

function service(root: string, name: string, config: Record<string, unknown> = {}, spec = SPEC): string {
    const dir = join(root, name)
    mkdirSync(join(dir, 'skills'), {recursive: true})
    writeFileSync(join(dir, 'spec.yaml'), spec)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
        api: {protocol: 'http', host: 'localhost', port: 3001},
        auth: {type: 'static-token', token: 'demo-token-123'}, ...config
    }))
    return dir
}

describe('scanServicesDirectory — one bad entry never takes the others down', () => {
    let root: string | undefined
    afterEach(() => {
        if (root) rmSync(root, {recursive: true, force: true});
        root = undefined
    })

    it('skips a dangling symlink in the services directory instead of failing boot', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'good')
        symlinkSync(join(root, 'gone'), join(root, 'dangling'))
        const scanned = await scanServicesDirectory(root, silent)
        expect(scanned.map(s => s.name)).toEqual(['good'])
    })

    it('fetches a URL spec at startup when no local spec file exists', async () => {
        const remoteSpec = `${SPEC}servers:\n  - url: http://remote.example/v1\n`
        let remoteRequests = 0
        const server = createServer((_req, res) => {
            remoteRequests++
            res.setHeader('Content-Type', 'application/yaml')
            res.end(remoteSpec)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        try {
            const dir = join(root, 'remote')
            mkdirSync(join(dir, 'skills'), {recursive: true})
            writeFileSync(join(dir, 'config.json'), JSON.stringify({
                spec: {
                    source: 'url',
                    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/spec.yaml`
                },
                serviceRefreshIntervalMs: 0,
                auth: {type: 'static-token', token: 'demo-token-123'}
            }))

            const [scanned] = await scanServicesDirectory(root, silent)

            expect(scanned?.spec).toMatchObject({openapi: '3.0.0'})
            expect(scanned?.apiConfig).toMatchObject({
                protocol: 'http',
                host: 'remote.example',
                port: 80,
                basePath: '/v1'
            })
            expect(remoteRequests).toBe(1)

            const cache = new InMemoryTokenCache(60_000)
            try {
                const resources = await buildServiceResources(scanned!, globalConfig, cache)
                resources.refresher.stop()
                expect(resources.specStore.getSpec().info.title).toBe('t')
                expect(remoteRequests).toBe(1)
            } finally {
                cache.destroy()
            }
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })

    it('uses the fresh URL spec instead of a stale local spec at startup', async () => {
        const remoteSpec = 'openapi: 3.0.0\ninfo: { title: remote, version: "2" }\npaths:\n  /remote: {}\n'
        const server = createServer((_req, res) => {
            res.setHeader('Content-Type', 'application/yaml')
            res.end(remoteSpec)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        try {
            service(root, 'remote', {
                spec: {
                    source: 'url-with-fallback',
                    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/spec.yaml`
                }
            }, 'openapi: 3.0.0\ninfo: { title: local, version: "1" }\npaths:\n  /stale: {}\n')

            const [scanned] = await scanServicesDirectory(root, silent)

            expect(scanned?.spec.info.title).toBe('remote')
            expect(scanned?.spec.paths).toHaveProperty('/remote')
            expect(scanned?.spec.paths).not.toHaveProperty('/stale')
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })

    it('allows URL-with-fallback to start without a local spec when the URL succeeds', async () => {
        const remoteSpec = 'openapi: 3.0.0\ninfo: { title: remote-fallback, version: "2" }\npaths:\n  /remote: {}\n'
        const server = createServer((_req, res) => {
            res.setHeader('Content-Type', 'application/yaml')
            res.end(remoteSpec)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        try {
            const dir = join(root, 'remote-fallback')
            mkdirSync(join(dir, 'skills'), {recursive: true})
            writeFileSync(join(dir, 'config.json'), JSON.stringify({
                spec: {
                    source: 'url-with-fallback',
                    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/spec.yaml`
                },
                auth: {type: 'static-token', token: 'demo-token-123'}
            }))

            const [scanned] = await scanServicesDirectory(root, silent)

            expect(scanned?.spec.info.title).toBe('remote-fallback')
            expect(scanned?.spec.paths).toHaveProperty('/remote')
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })

    it('falls back to the local spec when URL-with-fallback cannot fetch at startup', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'fallback', {
            spec: {
                source: 'url-with-fallback',
                url: 'http://127.0.0.1:1/unavailable.yaml'
            },
            serviceRefreshTimeoutMs: 100
        }, 'openapi: 3.0.0\ninfo: { title: local, version: "1" }\npaths:\n  /local: {}\n')

        const [scanned] = await scanServicesDirectory(root, silent)

        expect(scanned?.spec.info.title).toBe('local')
        expect(scanned?.spec.paths).toHaveProperty('/local')
    })

    it('skips a URL-only service when the initial fetch fails', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        const dir = join(root, 'unavailable')
        mkdirSync(join(dir, 'skills'), {recursive: true})
        writeFileSync(join(dir, 'config.json'), JSON.stringify({
            spec: {
                source: 'url',
                url: 'http://127.0.0.1:1/unavailable.yaml'
            },
            serviceRefreshTimeoutMs: 100,
            auth: {type: 'static-token', token: 'demo-token-123'}
        }))

        await expect(scanServicesDirectory(root, silent)).resolves.toEqual([])
    })

    it('skips only the skill file that cannot be parsed; keeps the standard skills', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        const dir = service(root, 'svc')
        writeFileSync(join(dir, 'skills', 'good.md'), '---\nname: good\ndescription: 2026 plan\nmetadata:\n  tags: "plan"\n---\n# Heading\nbody')
        writeFileSync(join(dir, 'skills', 'numeric.md'), '---\nname: numeric\ndescription: Numeric description\n---\nbody')
        writeFileSync(join(dir, 'skills', 'broken.md'), '---\ntitle: [unclosed\n---\nbody')
        mkdirSync(join(dir, 'skills', 'folder.md'))
        const skills = scanSkills(dir, silent)
        expect(skills.map(s => [s.name, s.description]).sort()).toEqual([
            ['good', '2026 plan'],
            ['numeric', 'Numeric description']
        ])
        expect(skills[0]?.content).not.toContain('---')
        const [scanned] = await scanServicesDirectory(root, silent)
        expect(scanned?.skills).toHaveLength(2)
    })

    it('a servers URL without a port means the scheme\'s port (80 for http)', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        const dir = join(root, 'svc')
        mkdirSync(dir)
        writeFileSync(join(dir, 'spec.yaml'), `${SPEC}servers:\n  - url: http://api.example.com/v1\n`)
        writeFileSync(join(dir, 'config.json'), JSON.stringify({auth: {type: 'static-token', token: 'demo-token-123'}}))
        const [scanned] = await scanServicesDirectory(root, silent)
        expect(scanned?.apiConfig).toMatchObject({protocol: 'http', host: 'api.example.com', port: 80, basePath: '/v1'})
    })

    it('refuses a refresh interval setInterval would clamp to 1 ms', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        for (const [name, ms] of [['negative', -1], ['tiny', 5], ['huge', 2_592_000_000], ['fraction', 1500.5]] as const) {
            service(root, name, {serviceRefreshIntervalMs: ms})
        }
        service(root, 'off', {serviceRefreshIntervalMs: 0})
        service(root, 'minute', {serviceRefreshIntervalMs: 60_000})
        const scanned = await scanServicesDirectory(root, silent)
        expect(scanned.map(s => s.name).sort()).toEqual(['minute', 'off'])
    })

    it('defaults governance rules to the service-local folder and normalizes custom per-service source settings', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'default')
        service(root, 'remote', {
            governance: {
                rulesSource: 'url',
                rulesUrl: 'https://policy.example/remote.yaml',
                rulesUrlTimeoutMs: 2500,
                rulesRefreshSec: 30
            }
        })
        const scanned = await scanServicesDirectory(root, silent)
        expect(scanned.find(s => s.name === 'default')?.governance).toEqual({
            rulesDir: join(root, 'default', 'governance', 'rules'),
            rulesSource: 'file',
            rulesUrlTimeoutMs: 5000,
            rulesRefreshSec: 0
        })
        expect(scanned.find(s => s.name === 'remote')?.governance).toEqual({
            rulesDir: join(root, 'remote', 'governance', 'rules'),
            rulesSource: 'url',
            rulesUrl: 'https://policy.example/remote.yaml',
            rulesUrlTimeoutMs: 2500,
            rulesRefreshSec: 30
        })
    })

    it('does not inspect governance settings for disabled services', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'disabled', {
            enabled: false,
            governance: {rulesSource: 'url', rulesRefreshSec: -1}
        })
        service(root, 'enabled')
        const scanned = await scanServicesDirectory(root, silent)
        expect(scanned.map(s => s.name)).toEqual(['enabled'])
    })

    it('rejects invalid service governance refresh and URL config instead of silently disabling policy', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'bad-refresh', {governance: {rulesRefreshSec: -1}})
        service(root, 'bad-url', {governance: {rulesSource: 'url'}})
        const scanned = await scanServicesDirectory(root, silent)
        expect(scanned).toEqual([])
    })

    it('an unknown idempotency type is refused, not silently turned into no deduplication', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'svc', {idempotency: {type: 'postgres'}})
        const [scanned] = await scanServicesDirectory(root, silent)
        expect(scanned?.idempotencyBackend).toEqual({type: 'postgres'})
        expect(() => buildIdempotencyStrategy(scanned!.idempotencyBackend)).toThrow('Unknown idempotency type: "postgres"')
    })

    it('a service without an idempotency block gets the gateway default (IDEMPOTENCY_TYPE); its own block wins', async () => {
        root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        service(root, 'inherits')
        service(root, 'own', {idempotency: {type: 'noop'}})
        const scanned = await scanServicesDirectory(root, silent)
        const cache = new InMemoryTokenCache(60_000)
        try {
            const config = {...globalConfig, defaultIdempotency: {type: 'in-memory' as const}}
            const byName = Object.fromEntries(await Promise.all(scanned.map(async svc => {
                const r = await buildServiceResources(svc, config, cache)
                r.refresher.stop()
                return [svc.name, r.idempotencyStrategyName]
            })))
            expect(byName).toEqual({inherits: 'in-memory', own: 'noop'})
        } finally {
            cache.destroy()
        }
    })
})

describe('buildServiceResources — gateway settings reach the backend call', () => {
    it('HARBOR_SERVER_ID (observability.serverId) is the X-Harbor-Server-ID the service\'s client sends', async () => {
        const seen: Array<Record<string, string | string[] | undefined>> = []
        const server = createServer((req, res) => {
            seen.push(req.headers);
            res.setHeader('Content-Type', 'application/json');
            res.end('{}')
        })
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
        const root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
        const cache = new InMemoryTokenCache(60_000)
        try {
            service(root, 'svc', {
                api: {
                    protocol: 'http',
                    host: '127.0.0.1',
                    port: (server.address() as AddressInfo).port
                }
            })
            const [scanned] = await scanServicesDirectory(root, silent)
            for (const serverId of ['harbor-eu-1', undefined]) {
                const config = {...globalConfig, observability: {...globalConfig.observability, serverId}}
                const resources = await buildServiceResources(scanned!, config, cache)
                resources.refresher.stop()
                await resources.apiClient.request({method: 'GET', path: '/ping'}, {
                    tokenPayload: {
                        access_token: 't',
                        token_type: 'bearer',
                        expires_in: 60,
                        refresh_token: '',
                        scope: ''
                    },
                    invalidate: async () => {
                    }, idempotencyKey: 'k', idempotencyKeyTtlMs: 1000, correlationId: 'c'
                })
            }
            expect(seen.map(h => h['x-harbor-server-id'])).toEqual(['harbor-eu-1', 'HARBOR_GATEWAY'])
        } finally {
            cache.destroy()
            rmSync(root, {recursive: true, force: true})
            await new Promise(r => server.close(r))
        }
    })
})

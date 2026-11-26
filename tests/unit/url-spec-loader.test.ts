// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import axios from 'axios'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {urlSpec, UrlSpecLoaderStrategy} from '../../src/adapters/spec/strategies/url-spec-loader.strategy.js'
import {SpecLoadError} from '../../src/core/types/spec.types.js'
import type {Logger} from '../../src/runtime/observability/logger.js'

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
            info: {title: 't', version: '1.0.0'},
            paths: {}
        }
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: JSON.stringify(validSpec),
            headers: {'content-type': 'application/json'}
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

describe('UrlSpecLoaderStrategy — a fetched spec cannot reach beyond itself', () => {
    beforeEach(() => {
        vi.mocked(axios.get).mockReset()
    })

    it('does not resolve $refs to local files or other URLs; internal refs still resolve', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'harbor-spec-'))
        const secret = join(dir, 'secret.json')
        writeFileSync(secret, JSON.stringify({GOVERNANCE_REQUEST_STATE_KEY: 'super-secret'}))
        try {
            for (const ref of [secret, `file://${secret}`, 'http://169.254.169.254/latest/meta-data']) {
                vi.mocked(axios.get).mockResolvedValueOnce({
                    status: 200, headers: {'content-type': 'application/json'},
                    data: JSON.stringify({
                        openapi: '3.0.0',
                        info: {title: 't', version: '1'},
                        paths: {},
                        components: {schemas: {Leak: {$ref: ref}}}
                    })
                })
                const loaded = await new UrlSpecLoaderStrategy('https://specs.example.com/openapi.json').load().catch((e: unknown) => e)
                expect(JSON.stringify(loaded), ref).not.toContain('super-secret')
            }
            expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(3) // only the spec itself was fetched
            vi.mocked(axios.get).mockResolvedValueOnce({
                status: 200, headers: {'content-type': 'application/json'},
                data: JSON.stringify({
                    openapi: '3.0.0',
                    info: {title: 't', version: '1'},
                    paths: {
                        '/a': {
                            get: {
                                responses: {
                                    200: {
                                        description: 'ok',
                                        content: {'application/json': {schema: {$ref: '#/components/schemas/A'}}}
                                    }
                                }
                            }
                        }
                    },
                    components: {schemas: {A: {type: 'string'}}}
                })
            })
            const ok = await new UrlSpecLoaderStrategy('https://specs.example.com/openapi.json').load()
            expect(JSON.stringify(ok.paths)).toContain('"type":"string"')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    it('keeps credentials out of logs and errors — the userinfo and a token parameter\'s value — while the query string stays', async () => {
        vi.mocked(axios.get).mockRejectedValueOnce(new Error('boom'))
        const logger = fakeLogger()
        const err = await new UrlSpecLoaderStrategy('https://user:pw@specs.example.com/openapi.yaml?token=abc', 5_000, logger as unknown as Logger).load().catch((e: unknown) => e) as Error
        expect(err.message).not.toMatch(/pw|token=abc/)
        expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/pw|token=abc/)
        expect(err.message).toContain('https://specs.example.com/openapi.yaml?token=REDACTED')
    })
})

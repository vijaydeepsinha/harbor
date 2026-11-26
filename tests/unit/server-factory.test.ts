// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it, vi} from 'vitest'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createMcpGateway, drainHttpGateway} from '../../src/runtime/server-factory.js'
import {globalConfig} from './code-mode-harness.js'

// The stdio transport itself is not under test: it would attach to this process's stdin.
vi.mock('../../src/runtime/transport/stdio-gateway.js', () => ({
    startStdioGateway: vi.fn(async () => {
    })
}))

function servicesDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
    mkdirSync(join(root, 'svc'))
    writeFileSync(join(root, 'svc', 'spec.yaml'), 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n')
    writeFileSync(join(root, 'svc', 'config.json'), JSON.stringify({
        api: {protocol: 'http', host: 'localhost', port: 3001}, auth: {type: 'static-token', token: 'demo-token-123'}
    }))
    return root
}

describe('createMcpGateway — stdio transport', () => {
    it('refuses to start with an MCP_TOKEN the bearer parser would reject on every call', async () => {
        const dir = servicesDir()
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`)
        }) as never)
        try {
            await expect(createMcpGateway(dir, {
                ...globalConfig,
                mcp: {...globalConfig.mcp, transport: 'stdio', token: 'demo-token-123'}
            }))
                .rejects.toThrow('exit 1')
            // A token that would pass the parser boots.
            await expect(createMcpGateway(dir, {
                ...globalConfig,
                mcp: {...globalConfig.mcp, transport: 'stdio', token: 'A'.repeat(40)}
            }))
                .resolves.toBeUndefined()
        } finally {
            exit.mockRestore()
            rmSync(dir, {recursive: true, force: true})
        }
    })
})

describe('drainHttpGateway', () => {
    it('does not tear down shared dependencies until the HTTP server has drained', async () => {
        const order: string[] = []
        let close: ((error?: Error) => void) | undefined
        const server = {
            close(callback: (error?: Error) => void) {
                order.push('close')
                close = callback
            }
        }
        const shutdown = vi.fn(async () => {
            order.push('shutdown')
        })

        const draining = drainHttpGateway(server, shutdown)
        await Promise.resolve()
        expect(order).toEqual(['close'])
        expect(shutdown).not.toHaveBeenCalled()

        close?.()
        await draining
        expect(order).toEqual(['close', 'shutdown'])
        expect(shutdown).toHaveBeenCalledOnce()
    })

    it('still tears down shared dependencies when closing the listener reports an error', async () => {
        const error = new Error('close failed')
        const shutdown = vi.fn(async () => {
        })
        const draining = drainHttpGateway({
            close(callback) {
                callback(error)
            }
        }, shutdown)

        await expect(draining).rejects.toBe(error)
        expect(shutdown).toHaveBeenCalledOnce()
    })
})

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpGateway } from '../../src/runtime/server-factory.js'
import { globalConfig } from './code-mode-harness.js'

// The stdio transport itself is not under test: it would attach to this process's stdin.
vi.mock('../../src/runtime/transport/stdio-gateway.js', () => ({ startStdioGateway: vi.fn(async () => {}) }))

function servicesDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'harbor-svcs-'))
  mkdirSync(join(root, 'svc'))
  writeFileSync(join(root, 'svc', 'spec.yaml'), 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n')
  writeFileSync(join(root, 'svc', 'config.json'), JSON.stringify({
    api: { protocol: 'http', host: 'localhost', port: 3001 }, auth: { type: 'static-token', token: 'demo-token-123' }
  }))
  return root
}

describe('createMcpGateway — stdio transport', () => {
  it('refuses to start with an MCP_TOKEN the bearer parser would reject on every call', async () => {
    const dir = servicesDir()
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    try {
      await expect(createMcpGateway(dir, { ...globalConfig, mcp: { ...globalConfig.mcp, transport: 'stdio', token: 'demo-token-123' } }))
        .rejects.toThrow('exit 1')
      // A token that would pass the parser boots.
      await expect(createMcpGateway(dir, { ...globalConfig, mcp: { ...globalConfig.mcp, transport: 'stdio', token: 'A'.repeat(40) } }))
        .resolves.toBeUndefined()
    } finally {
      exit.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

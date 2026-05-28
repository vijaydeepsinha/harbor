// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import { runSpecSearchInSandbox } from '../../runtime/sandbox/spec-search-in-sandbox.js'
import { SpecStore } from '../../runtime/spec/spec-store.js'
import { forwardTokenPermissionGuard } from '../../spi/permissions/strategies/forward-token-permission-guard.strategy.js'
import type { SandboxLimits } from '../../core/types/config.types.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import sampleSpec from '../fixtures/sample-spec.json' assert { type: 'json' }

const testLimits: SandboxLimits = {
  memoryLimitMb: 64,
  executeTimeoutMs: 8000,
  searchTimeoutMs: 3000,
  maxApiCalls: 50,
  maxConcurrentCalls: 5
}

const testToken: TokenPayload = {
  access_token: 'test-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'refresh',
  scope: 'login_mode:self'
}

describe('search_code integration', () => {
  it('keyword filter on sample-spec returns correct endpoints', async () => {
    const result = await runSpecSearchInSandbox(
      `async () => {
        return Object.keys(spec.paths).filter(p => p.includes('campaign'))
      }`,
      sampleSpec as Record<string, unknown>,
      testLimits
    ) as string[]

    expect(result).toContain('/campaigns')
    expect(result).toContain('/campaigns/{id}')
    expect(result).toContain('/campaigns/{id}/lineitems')
    expect(result).not.toContain('/orders')
  })

  it('drill-down on nested schema returns full schema object', async () => {
    const result = await runSpecSearchInSandbox(
      `async () => {
        const op = spec.paths['/campaigns']?.post
        return op?.requestBody?.content?.['application/json']?.schema?.properties?.budget?.properties?.pacing
      }`,
      sampleSpec as Record<string, unknown>,
      testLimits
    ) as Record<string, unknown>

    expect(result).toBeDefined()
    expect((result.properties as Record<string, unknown>)?.strategy).toBeDefined()
  })

  it('filter returning empty array does not crash server', async () => {
    const result = await runSpecSearchInSandbox(
      `async () => {
        return Object.keys(spec.paths).filter(p => p.includes('nonexistent-xyz-path'))
      }`,
      sampleSpec as Record<string, unknown>,
      testLimits
    )
    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(0)
  })

  it('after spec store swap, search_code sees new spec immediately', async () => {
    const store = new SpecStore()
    store.swap(sampleSpec as Record<string, unknown>)

    const result1 = await runSpecSearchInSandbox(
      `async () => Object.keys(spec.paths)`,
      store.getSpec(),
      testLimits
    ) as string[]
    expect(result1).toContain('/orders')

    // Swap to new spec
    store.swap({ paths: { '/invoices': {} } })

    const result2 = await runSpecSearchInSandbox(
      `async () => Object.keys(spec.paths)`,
      store.getSpec(),
      testLimits
    ) as string[]
    expect(result2).toContain('/invoices')
    expect(result2).not.toContain('/orders')
  })

  it('permission guard filterSpec is called before sandbox injection', async () => {
    const guard = forwardTokenPermissionGuard()
    const filterSpy = vi.spyOn(guard, 'filterSpec')

    const spec = sampleSpec as Record<string, unknown>
    const filteredSpec = guard.filterSpec(spec, testToken)

    await runSpecSearchInSandbox(
      `async () => Object.keys(spec.paths)`,
      filteredSpec,
      testLimits
    )

    expect(filterSpy).toHaveBeenCalledWith(spec, testToken)
  })
})

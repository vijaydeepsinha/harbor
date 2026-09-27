// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-026 fail closed at boot: a gateway pointed at an invalid Governance Rule
 * file must refuse to start — a typo can never silently become "no rule".
 *
 * Runs the *real* gateway: the Docker image when the orchestrator provides
 * HARBOR_IMAGE (compose mode), otherwise `node --import tsx index.ts` from
 * the repository (local mode). Both must exit non-zero and say why.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../helpers/env.js'
import { materializeServices } from '../setup/materialize-services.mjs'

const INVALID_RULES = join(env.repoRoot, 'tests/e2e/fixtures/governance/invalid')
const SERVICES = join(env.repoRoot, 'tests/e2e/fixtures/services')

function bootWithInvalidRules(): { status: number | null; output: string } {
  if (env.harborImage) {
    const r = spawnSync('docker', [
      'run', '--rm', '--network', 'none',
      '-e', 'GOVERNANCE_RULES_DIR=/app/e2e/governance', '-e', 'SERVICES_DIR=/app/e2e/services', '-e', 'LOG_LEVEL=error',
      '-v', `${INVALID_RULES}:/app/e2e/governance:ro`, '-v', `${SERVICES}:/app/e2e/services:ro`,
      env.harborImage
    ], { encoding: 'utf8', timeout: 120_000 })
    return { status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') }
  }
  const services = join(env.repoRoot, 'artifacts', 'e2e', 'boot-services')
  mkdirSync(join(env.repoRoot, 'artifacts', 'e2e'), { recursive: true })
  if (!existsSync(services)) materializeServices(SERVICES, services, { host: '127.0.0.1', port: 4010 })
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: env.repoRoot, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, GOVERNANCE_RULES_DIR: INVALID_RULES, SERVICES_DIR: services, MCP_PORT: '3999', LOG_LEVEL: 'error', EXECUTION_STORE_TYPE: 'in-memory' }
  })
  return { status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('gateway boot', () => {
  it('should_refuse_to_start_when_a_governance_rule_file_is_invalid', () => {
    const { status, output } = bootWithInvalidRules()
    expect(status, output.slice(-2000)).not.toBe(0)
    expect(output).toContain('invalid Governance Rule')
    expect(output).toContain('10-broken.yaml')
  }, 150_000)
})

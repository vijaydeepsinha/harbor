// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-026 fail closed at boot: a gateway pointed at an invalid Governance Rule
 * file must refuse to start — a typo can never silently become "no rule".
 *
 * Runs the *real* gateway: the Docker image when the orchestrator provides
 * HARBOR_IMAGE (compose mode), otherwise `node --import tsx src/index.ts` from
 * the repository (local mode). Both must exit non-zero and say why.
 */
import {describe, expect, it} from 'vitest'
import {spawnSync} from 'node:child_process'
import {cpSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {env} from '../helpers/env.js'
import {materializeServices} from '../setup/materialize-services.mjs'

const INVALID_RULES = join(env.repoRoot, 'tests/e2e/fixtures/governance/invalid')
const GATEWAY_RULES = join(env.repoRoot, 'tests/e2e/fixtures/governance/gateway')
const SERVICES = join(env.repoRoot, 'tests/e2e/fixtures/services')

function bootWithInvalidRules(): { status: number | null; output: string } {
    const services = join(env.repoRoot, 'artifacts', 'e2e', 'boot-invalid-services')
    mkdirSync(join(env.repoRoot, 'artifacts', 'e2e'), {recursive: true})
    materializeServices(SERVICES, services, {host: '127.0.0.1', port: 4010})
    const invalidServiceRules = join(services, 'commerce', 'governance', 'rules')
    mkdirSync(invalidServiceRules, {recursive: true})
    cpSync(INVALID_RULES, invalidServiceRules, {recursive: true})
    if (env.harborImage) {
        const r = spawnSync('docker', [
            'run', '--rm', '--network', 'none',
            '-e', 'SERVICES_DIR=/app/e2e/services',
            '-e', 'GATEWAY_GOVERNANCE_RULES_DIR=/app/e2e/gateway-governance',
            '-e', 'LOG_LEVEL=error',
            '-v', `${services}:/app/e2e/services:ro`,
            '-v', `${GATEWAY_RULES}:/app/e2e/gateway-governance:ro`,
            env.harborImage
        ], {encoding: 'utf8', timeout: 120_000})
        return {status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '')}
    }
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: env.repoRoot, encoding: 'utf8', timeout: 120_000,
        env: {
            ...process.env,
            SERVICES_DIR: services,
            GATEWAY_GOVERNANCE_RULES_DIR: GATEWAY_RULES,
            MCP_PORT: '3999',
            LOG_LEVEL: 'error',
            EXECUTION_STORE_TYPE: 'in-memory'
        }
    })
    return {status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '')}
}

describe('gateway boot', () => {
    it('should_refuse_to_start_when_a_governance_rule_file_is_invalid', () => {
        const {status, output} = bootWithInvalidRules()
        expect(status, output.slice(-2000)).not.toBe(0)
        expect(output).toContain('invalid Governance Rule')
        expect(output).toContain('10-broken.yaml')
    }, 150_000)
})

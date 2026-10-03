// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** vitest setup file: validates the environment contract once and confirms the targets are alive before any test runs. */
import {mkdirSync} from 'node:fs'
import {env} from './env.js'
import {waitForHealth} from './wait.js'

mkdirSync(env.artifactsDir, {recursive: true})

const health = await waitForHealth(env.mcpBaseUrl, 30_000)
if (health['protocolVersion'] !== '2026-07-28') {
    throw new Error(`Gateway at ${env.mcpBaseUrl} reports protocolVersion ${String(health['protocolVersion'])}; expected 2026-07-28`)
}
const mock = await fetch(`${env.mockApiUrl}/health`, {signal: AbortSignal.timeout(5000)})
if (!mock.ok) throw new Error(`Mock API at ${env.mockApiUrl} is not healthy (${mock.status})`)
if (env.strictBaseUrl) await waitForHealth(env.strictBaseUrl, 30_000)

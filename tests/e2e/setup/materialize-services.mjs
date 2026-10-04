// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Copies `tests/e2e/fixtures/services` to a target directory, rewriting the
 * backend host/port in every `config.json`. The committed fixtures point at
 * the Compose DNS name `mock-api`; local-process mode needs 127.0.0.1.
 */
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function materializeServices(sourceDir, targetDir, {host, port, governanceProfile}) {
    if (existsSync(targetDir)) rmSync(targetDir, {recursive: true, force: true})
    mkdirSync(targetDir, {recursive: true})
    cpSync(sourceDir, targetDir, {recursive: true})
    for (const entry of readdirSync(targetDir)) {
        const cfgPath = join(targetDir, entry, 'config.json')
        if (!existsSync(cfgPath)) continue
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
        cfg.api = {...(cfg.api ?? {}), host, port}
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
        if (governanceProfile) {
            const sourceRules = join(governanceProfile, entry)
            if (existsSync(sourceRules)) {
                const targetRules = join(targetDir, entry, 'governance', 'rules')
                mkdirSync(targetRules, {recursive: true})
                cpSync(sourceRules, targetRules, {recursive: true})
            }
        }
    }
    return targetDir
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const [source, target, host = '127.0.0.1', port = '4010'] = process.argv.slice(2)
    if (!source || !target) {
        console.error('usage: materialize-services.mjs <sourceDir> <targetDir> [host] [port]');
        process.exit(2)
    }
    console.log(materializeServices(source, target, {host, port: Number(port)}))
}

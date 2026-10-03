// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import type {Logger} from '../../core/types/logger.types.js'
import type {ExecutionPersistence} from '../../spi/execution/execution-store.js'
import {EXECUTION_STORE_TYPE} from '../../core/constants.js'
import {errorMessage} from '../../core/utils/errors.js'
import {type ExecutionSnapshot, InMemoryExecutionStore} from './in-memory-execution-store.js'

/**
 * File-backed store: one JSON document per execution under `dir`, written
 * through on every mutation (temp file + rename, so a crash mid-write never
 * leaves a torn document) and reloaded on construction. Enough for a single
 * gateway process to survive a restart without introducing a database.
 *
 * Locks are process-local (inherited) — a durable lock is a follow-up for
 * multi-instance deployments; see docs/code-mode-governance.md.
 */
export class FileExecutionStore extends InMemoryExecutionStore {
    override readonly name: string = EXECUTION_STORE_TYPE.FILE

    constructor(private readonly dir: string, private readonly logger?: Logger) {
        super()
        mkdirSync(dir, {recursive: true})
        this.loadAll()
    }

    override async deleteExecution(executionId: string): Promise<void> {
        await super.deleteExecution(executionId)
        rmSync(this.fileFor(executionId), {force: true})
    }

    protected override async persist(executionId: string): Promise<void> {
        const snap = this.snapshot(executionId)
        if (!snap) return
        const file = this.fileFor(executionId)
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8')
        renameSync(tmp, file)
    }

    private loadAll(): void {
        let files: string[]
        try {
            files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
        } catch (err) {
            this.logger?.warn({dir: this.dir, error: errorMessage(err)}, 'Execution store directory unreadable')
            return
        }
        let loaded = 0
        for (const f of files) {
            try {
                const snap = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ExecutionSnapshot
                if (!snap?.execution?.executionId) continue
                this.restore(snap)
                loaded++
            } catch (err) {
                this.logger?.warn({file: f, error: errorMessage(err)}, 'Skipping unreadable execution document')
            }
        }
        if (loaded > 0) this.logger?.info({dir: this.dir, executions: loaded}, 'Execution store loaded from disk')
    }

    private fileFor(executionId: string): string {
        // executionIds are UUIDs minted by Harbor; guard anyway so a bad id can't escape the directory.
        if (!/^[A-Za-z0-9-]+$/.test(executionId)) throw new Error(`Invalid executionId for file store: ${executionId}`)
        return join(this.dir, `${executionId}.json`)
    }
}

export function fileExecutionStore(dir: string, logger?: Logger): ExecutionPersistence {
    return new FileExecutionStore(dir, logger)
}

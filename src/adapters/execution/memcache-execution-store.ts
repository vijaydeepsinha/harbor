// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {v4 as uuidv4} from 'uuid'
import type {ExecutionPersistence} from '../../spi/execution/execution-store.js'
import type {
    ActivityRecord,
    ApprovalRecord,
    ExecutionRecord,
    GovernanceDecisionRecord
} from '../../core/types/execution.types.js'
import type {MemcacheConnectionConfig} from '../../core/types/config.types.js'
import {EXECUTION_STORE_TYPE} from '../../core/constants.js'
import {createMemcacheClient} from '../infra/memcache-client.js'

/** The memcache operations this store uses. memjs.Client satisfies it; tests pass an in-memory fake. */
export interface MemcacheKv {
    get(key: string): Promise<{ value: Buffer | string | null }>

    set(key: string, value: string, options?: { expires?: number }): Promise<boolean>

    /** Atomic: stores only if the key is absent; `false` when it exists. */
    add(key: string, value: string, options?: { expires?: number }): Promise<boolean>

    delete(key: string): Promise<boolean>

    touch(key: string, expires: number): Promise<boolean>

    close?(): void
}

export interface MemcacheExecutionStoreOptions {
    /** Namespace for every key, so several gateways (or environments) can share one memcache. */
    keyPrefix?: string
    /**
     * How long a run lock outlives a holder that died without releasing it.
     * Must exceed the longest run (SANDBOX_EXECUTE_TIMEOUT_MS, per-service
     * overrides included), or a second pod could start a run that is still live.
     */
    lockTtlSec?: number
    /** Epoch-ms clock used to turn `expiresAt` into item TTLs (tests). */
    nowMs?: () => number
}

export const DEFAULT_MEMCACHE_KEY_PREFIX = 'harbor:exec:'
export const DEFAULT_MEMCACHE_LOCK_TTL_SEC = 300
/** Memcached reads an `expires` above 30 days as an absolute Unix time, not a duration. */
const MAX_RELATIVE_TTL_SEC = 30 * 24 * 3600

/**
 * Shared execution store for multi-pod deployments: every pod reads and
 * writes the same memcache, so a run paused on one pod can be approved and
 * resumed on another, and the run lock is held across pods.
 *
 * - No local cache: every read goes to memcache, so pods never disagree.
 * - One item per record kind (execution, each activity, each approval, the
 *   decisions, index keys) — an activity holds a full response body, and
 *   memcache items are capped (1 MB by default).
 * - The run lock is an atomic `add` with a TTL, so the lock of a pod that
 *   crashed mid-run expires after `lockTtlSec`; only its holder releases it.
 * - Retention is native: when an execution becomes terminal with an
 *   `expiresAt`, all its items get that TTL, so `listExpiredExecutions` has
 *   nothing to report. Items without a TTL can still be evicted under memory
 *   pressure — size memcache for the executions you keep, and treat the audit
 *   trail as the durable record.
 * - Index keys (activity high-water mark, approval ids, decisions) are
 *   read-modify-write. That is safe because only the run-lock holder creates
 *   activities, approvals and decisions; a human decision only updates
 *   records that already exist.
 */
export class MemcacheExecutionStore implements ExecutionPersistence {
    readonly name: string = EXECUTION_STORE_TYPE.MEMCACHE
    private readonly prefix: string
    private readonly lockTtlSec: number
    private readonly nowMs: () => number
    /** Identifies this process's locks, so it never releases a lock another pod took after ours expired. */
    private readonly owner = uuidv4()

    constructor(private readonly kv: MemcacheKv, options: MemcacheExecutionStoreOptions = {}) {
        this.prefix = options.keyPrefix ?? DEFAULT_MEMCACHE_KEY_PREFIX
        this.lockTtlSec = options.lockTtlSec ?? DEFAULT_MEMCACHE_LOCK_TTL_SEC
        this.nowMs = options.nowMs ?? Date.now
    }

    // ── executions ────────────────────────────────────────────────────────────

    async createExecution(record: ExecutionRecord): Promise<void> {
        const stored = await this.kv.add(this.executionKey(record.executionId), JSON.stringify(record), {expires: this.ttlFor(record)})
        if (!stored) throw new Error(`Execution ${record.executionId} already exists`)
    }

    async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
        return this.read<ExecutionRecord>(this.executionKey(executionId))
    }

    async updateExecution(record: ExecutionRecord): Promise<void> {
        const key = this.executionKey(record.executionId)
        if ((await this.read(key)) === undefined) throw new Error(`Execution ${record.executionId} does not exist`)
        const ttl = this.ttlFor(record)
        await this.write(key, JSON.stringify(record), {expires: ttl})
        // Terminal with a retention period: everything recorded for it expires with it.
        if (ttl > 0) {
            for (const itemKey of await this.itemKeys(record.executionId)) {
                const {value} = await this.kv.get(itemKey)
                if (value !== null && !await this.kv.touch(itemKey, ttl)) {
                    throw new Error(`Memcache touch failed for ${itemKey}`)
                }
            }
        }
    }

    async deleteExecution(executionId: string): Promise<void> {
        for (const key of await this.itemKeys(executionId)) await this.kv.delete(key)
        await this.kv.delete(this.lockKey(executionId))
        await this.kv.delete(this.executionKey(executionId))
    }

    /** Expiry is native (item TTLs): there is never anything left for a sweep to delete. */
    async listExpiredExecutions(): Promise<string[]> {
        return []
    }

    // ── activities ────────────────────────────────────────────────────────────

    async putActivity(record: ActivityRecord): Promise<void> {
        await this.write(this.activityKey(record.executionId, record.sequence), JSON.stringify(record))
        const highest = await this.highestSequence(record.executionId)
        if (record.sequence > highest) await this.write(this.activityIndexKey(record.executionId), String(record.sequence))
    }

    async getActivity(executionId: string, sequence: number): Promise<ActivityRecord | undefined> {
        return this.read<ActivityRecord>(this.activityKey(executionId, sequence))
    }

    async listActivities(executionId: string): Promise<ActivityRecord[]> {
        const activities: ActivityRecord[] = []
        const highest = await this.highestSequence(executionId)
        for (let sequence = 1; sequence <= highest; sequence++) {
            const activity = await this.getActivity(executionId, sequence)
            if (activity) activities.push(activity)
        }
        return activities
    }

    // ── approvals ─────────────────────────────────────────────────────────────

    async putApproval(record: ApprovalRecord): Promise<void> {
        await this.write(this.approvalKey(record.approvalId), JSON.stringify(record))
        const ids = await this.approvalIds(record.executionId)
        if (!ids.includes(record.approvalId)) {
            await this.write(this.approvalIndexKey(record.executionId), JSON.stringify([...ids, record.approvalId]))
        }
    }

    async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
        return this.read<ApprovalRecord>(this.approvalKey(approvalId))
    }

    async listApprovals(executionId: string): Promise<ApprovalRecord[]> {
        const approvals: ApprovalRecord[] = []
        for (const approvalId of await this.approvalIds(executionId)) {
            const approval = await this.getApproval(approvalId)
            if (approval) approvals.push(approval)
        }
        return approvals.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }

    // ── decisions ─────────────────────────────────────────────────────────────

    async putDecision(record: GovernanceDecisionRecord): Promise<void> {
        const key = this.decisionsKey(record.executionId)
        const decisions = (await this.read<GovernanceDecisionRecord[]>(key)) ?? []
        await this.write(key, JSON.stringify([...decisions, record]))
    }

    async listDecisions(executionId: string): Promise<GovernanceDecisionRecord[]> {
        return ((await this.read<GovernanceDecisionRecord[]>(this.decisionsKey(executionId))) ?? [])
            .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt))
    }

    // ── run lock (shared by every pod) ────────────────────────────────────────

    async acquireLock(executionId: string): Promise<boolean> {
        return this.kv.add(this.lockKey(executionId), this.owner, {expires: this.lockTtlSec})
    }

    async releaseLock(executionId: string): Promise<void> {
        const key = this.lockKey(executionId)
        const {value} = await this.kv.get(key)
        if (value !== null && value.toString() === this.owner) await this.kv.delete(key)
    }

    async destroy(): Promise<void> {
        this.kv.close?.()
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private async read<T>(key: string): Promise<T | undefined> {
        const {value} = await this.kv.get(key)
        return value === null ? undefined : (JSON.parse(value.toString()) as T)
    }

    private async write(key: string, value: string, options?: { expires?: number }): Promise<void> {
        if (!await this.kv.set(key, value, options)) throw new Error(`Memcache set failed for ${key}`)
    }

    private async highestSequence(executionId: string): Promise<number> {
        const {value} = await this.kv.get(this.activityIndexKey(executionId))
        return value === null ? 0 : Number(value.toString())
    }

    private async approvalIds(executionId: string): Promise<string[]> {
        return (await this.read<string[]>(this.approvalIndexKey(executionId))) ?? []
    }

    /** Every item recorded for an execution except the execution record and its lock. */
    private async itemKeys(executionId: string): Promise<string[]> {
        const highest = await this.highestSequence(executionId)
        const approvalIds = await this.approvalIds(executionId)
        return [
            ...Array.from({length: highest}, (_, i) => this.activityKey(executionId, i + 1)),
            this.activityIndexKey(executionId),
            ...approvalIds.map(id => this.approvalKey(id)),
            this.approvalIndexKey(executionId),
            this.decisionsKey(executionId)
        ]
    }

    /** Seconds until `expiresAt` (at least 1), as memcached reads `expires`; 0 = no expiry. */
    private ttlFor(record: ExecutionRecord): number {
        if (record.expiresAt === undefined) return 0
        const expiresMs = Date.parse(record.expiresAt)
        const seconds = Math.max(1, Math.ceil((expiresMs - this.nowMs()) / 1000))
        return seconds <= MAX_RELATIVE_TTL_SEC ? seconds : Math.ceil(expiresMs / 1000)
    }

    private executionKey(executionId: string): string {
        return `${this.prefix}${safeId(executionId)}`
    }

    private activityKey(executionId: string, sequence: number): string {
        return `${this.executionKey(executionId)}:a:${sequence}`
    }

    private activityIndexKey(executionId: string): string {
        return `${this.executionKey(executionId)}:a`
    }

    private approvalIndexKey(executionId: string): string {
        return `${this.executionKey(executionId)}:ap`
    }

    private decisionsKey(executionId: string): string {
        return `${this.executionKey(executionId)}:d`
    }

    private lockKey(executionId: string): string {
        return `${this.executionKey(executionId)}:lock`
    }

    private approvalKey(approvalId: string): string {
        return `${this.prefix}ap:${safeId(approvalId)}`
    }
}

/** Ids are Harbor-minted UUIDs; anything else (spaces, control characters) could forge or break a memcache key. */
function safeId(id: string): string {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error(`Invalid id for the memcache store: ${id}`)
    return id
}

export function memcacheExecutionStore(config: MemcacheConnectionConfig & {
    keyPrefix?: string;
    lockTtlSec?: number
}): ExecutionPersistence {
    return new MemcacheExecutionStore(createMemcacheClient(config), {
        ...(config.keyPrefix !== undefined ? {keyPrefix: config.keyPrefix} : {}),
        ...(config.lockTtlSec !== undefined ? {lockTtlSec: config.lockTtlSec} : {})
    })
}

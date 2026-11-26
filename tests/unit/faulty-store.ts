// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Fault injection for the execution store: an in-memory store whose chosen
 * writes fail, so a test can stop a multi-write operation between any two
 * writes — what a store outage or a crash at that point leaves behind — and
 * then check what the client saw and how the next run recovers.
 */
import {InMemoryExecutionStore} from '../../src/adapters/execution/in-memory-execution-store.js'
import type {ExecutionPersistence} from '../../src/spi/execution/execution-store.js'

type Method = keyof ExecutionPersistence & string

export interface Fault {
    method: Method
    /** Which calls of `method` fail; default every one. Receives the call's arguments. */
    when?: (...args: unknown[]) => boolean
    /** How many matching calls fail before the store works again; default 1. */
    times?: number
    /** `after` simulates an applied write whose acknowledgement was lost. */
    timing?: 'before' | 'after'
}

export class StoreDownError extends Error {
    constructor(method: string) {
        super(`store unavailable (${method})`)
        this.name = 'StoreDownError'
    }
}

export interface FaultyStore {
    persistence: ExecutionPersistence
    /** Every write attempted, in order, with whether it failed — to assert what was and was not stored. */
    writes: Array<{ method: Method; failed: boolean }>
    /** The underlying store, for reading back state without faults. */
    inner: InMemoryExecutionStore

    /** Arms a fault; earlier faults stay armed until used up. */
    fail(fault: Fault): void
}

const WRITES: ReadonlySet<string> = new Set([
    'createExecution', 'updateExecution', 'putActivity', 'putApproval', 'putDecision', 'deleteExecution'
])

export function faultyStore(): FaultyStore {
    const inner = new InMemoryExecutionStore()
    const faults: Array<Required<Fault>> = []
    const writes: FaultyStore['writes'] = []
    const persistence = new Proxy(inner, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown
            if (typeof value !== 'function' || typeof prop !== 'string') return value
            return async (...args: unknown[]) => {
                const fault = faults.find(f => f.method === prop && f.times > 0 && f.when(...args))
                if (WRITES.has(prop)) writes.push({method: prop as Method, failed: fault !== undefined})
                if (fault?.timing === 'before') {
                    fault.times--
                    throw new StoreDownError(prop)
                }
                const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args)
                if (fault) {
                    fault.times--
                    throw new StoreDownError(prop)
                }
                return result
            }
        }
    }) as ExecutionPersistence
    return {
        persistence, inner, writes,
        fail: fault => {
            faults.push({when: () => true, times: 1, timing: 'before', ...fault})
        }
    }
}

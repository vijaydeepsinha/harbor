// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {LoadedRule} from './rule-loader.js'
import {ruleVersionTag} from './rule-loader.js'

/**
 * Holds the active rule set (§39 GovernanceRuleStore). `swap` replaces the
 * whole set atomically so an evaluation never sees half a reload — the same
 * shape as SpecStore / SkillStore.
 */
export class GovernanceRuleStore {
    private current: LoadedRule[] = []
    private loadedAt: string | undefined

    getRules(): LoadedRule[] {
        return this.current
    }

    swap(rules: LoadedRule[], at: string = new Date().toISOString()): void {
        this.current = rules
        this.loadedAt = at
    }

    /** For inspection endpoints and logs. */
    describe(): { count: number; loadedAt?: string; rules: string[] } {
        return {
            count: this.current.length,
            ...(this.loadedAt !== undefined ? {loadedAt: this.loadedAt} : {}),
            rules: this.current.map(ruleVersionTag)
        }
    }
}

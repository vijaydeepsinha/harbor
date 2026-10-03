// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {Logger} from '../../core/types/logger.types.js'
import type {GovernanceRuleSource} from '../../spi/governance/rule-source.js'
import type {GovernanceRuleStore} from './rule-store.js'
import {parseRuleDocuments, ruleVersionTag} from './rule-loader.js'
import {errorMessage} from '../../core/utils/errors.js'

export type RuleRefreshResult = 'swapped' | 'unchanged' | 'failed' | 'skipped'

/**
 * Re-reads the rule source every `intervalSec` seconds so rules can change
 * without a redeploy (same shape as the per-service spec refresher).
 *
 * Last-known-good: a refresh that cannot read the source, reads a set that
 * does not validate, or reads an empty set while rules are in force, changes
 * nothing — the previous set keeps being enforced and the failure is logged
 * on every attempt. A set is only ever swapped in
 * whole, so an evaluation never sees half an update. (At boot there is no
 * previous set: a bad first load stops the gateway instead.)
 */
export class GovernanceRuleRefresher {
    private timer: ReturnType<typeof setInterval> | null = null
    private running = false

    constructor(
        private readonly source: GovernanceRuleSource,
        private readonly store: GovernanceRuleStore,
        private readonly intervalSec: number,
        private readonly logger: Logger
    ) {
    }

    start(): void {
        if (this.intervalSec <= 0) {
            this.logger.info({source: this.source.name}, 'Governance rule refresh disabled (GOVERNANCE_RULES_REFRESH_SEC = 0)')
            return
        }
        this.timer = setInterval(() => {
            void this.refresh()
        }, this.intervalSec * 1000)
        if (this.timer.unref) this.timer.unref()
        this.logger.info({source: this.source.name, intervalSec: this.intervalSec}, 'Governance rule refresh started')
    }

    /** One refresh. Never throws; says what happened. A refresh already in flight makes this one a no-op. */
    async refresh(): Promise<RuleRefreshResult> {
        if (this.running) return 'skipped'
        this.running = true
        try {
            const next = parseRuleDocuments(await this.source.load())
            const nextTags = next.map(ruleVersionTag)
            const currentTags = this.store.describe().rules
            // Going from some rules to none turns every call into NO_GOVERNANCE
            // (ALLOW). A refresh is not allowed to do that: a file renamed aside by
            // a deploy, a half-synced directory or a URL answering `rules: []` look
            // exactly like it. Clearing every rule takes a restart (boot accepts an
            // empty set, and says so).
            if (next.length === 0 && currentTags.length > 0) {
                throw new Error(`the source returned no rules; refusing to replace the ${currentTags.length} rule(s) in force with an empty set — restart the gateway to clear all rules`)
            }
            if (nextTags.length === currentTags.length && nextTags.every((tag, i) => tag === currentTags[i])) return 'unchanged'
            this.store.swap(next)
            this.logger.info({source: this.source.name, rules: nextTags}, 'Governance rules refreshed')
            return 'swapped'
        } catch (err) {
            this.logger.error(
                {source: this.source.name, error: errorMessage(err)},
                'Governance rule refresh failed — keeping the last valid rule set'
            )
            return 'failed'
        } finally {
            this.running = false
        }
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}

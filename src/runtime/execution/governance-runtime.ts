// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {resolve} from 'node:path'
import type {ExecutionConfig} from '../../core/types/config.types.js'
import type {Logger} from '../../core/types/logger.types.js'
import type {ExecutionPersistence} from '../../spi/execution/execution-store.js'
import type {GovernanceRuleSourceConfig} from '../../core/types/config.types.js'
import {
    buildExecutionStore,
    buildGovernanceRuleSource,
    buildGatewayGovernanceRuleSource,
    GovernanceRulesDirectoryAbsentError
} from '../../wiring/strategy-builders.js'
import type {GovernanceRuleDocument, GovernanceRuleSource} from '../../spi/governance/rule-source.js'
import {ExecutionManager} from './execution-manager.js'
import {ExecutionRetentionSweeper} from './execution-retention.js'
import {ApprovalService} from './approval-service.js'
import {createResumeStateCodec, type ResumeStateCodec} from './request-state.js'
import {GovernanceRuleStore} from '../governance/rule-store.js'
import {parseRuleDocuments} from '../governance/rule-loader.js'
import {GovernanceRuleRefresher} from '../governance/rule-refresher.js'
import {AuditPipeline, executionStateOf} from '../observability/audit-pipeline.js'
import {errorMessage} from '../../core/utils/errors.js'
import type {LoadedRule} from '../governance/rule-loader.js'

/**
 * Shared governance runtime dependencies for execution, approvals and rules, built once per
 * process (executions outlive MCP requests and V8 isolates, so none of this
 * may live in the per-request McpServer factory).
 */
export interface GovernanceRuntime {
    persistence: ExecutionPersistence
    executionManager: ExecutionManager
    approvals: ApprovalService
    /** Returns the gateway-owned rules shared by calls to every enabled service. */
    gatewayRules(): readonly LoadedRule[]
    /** Returns the active rules for a registered service; throws for an unknown service. */
    rulesForService(service: string): readonly LoadedRule[]
    requestState: ResumeStateCodec
    executionConfig: ExecutionConfig

    shutdown(): Promise<void>
}

/** Governance source settings for an enabled, registered service. */
export interface ServiceGovernanceSource {
    name: string
    governance: GovernanceRuleSourceConfig
}

export async function buildGovernanceRuntime(
    config: ExecutionConfig,
    services: readonly ServiceGovernanceSource[],
    logger: Logger,
    audit?: AuditPipeline
): Promise<GovernanceRuntime> {
    const persistence = buildExecutionStore(config.store, logger)
    const manager: ExecutionManager = new ExecutionManager(persistence, undefined, undefined, {
        ...(config.retention?.code !== undefined ? {codeRetention: config.retention.code} : {}),
        retentionSec: config.retention?.executionSec ?? 0,
        // Every persisted state change of an execution goes to the audit trail (statuses, approvals, decisions — no payloads).
        ...(audit ? {
            onStateChange: (executionId: string) => {
                void manager.inspect(executionId)
                    .then(inspection => audit.publish({kind: 'execution', state: executionStateOf(inspection)}))
                    .catch(err => logger.warn({
                        executionId,
                        error: errorMessage(err)
                    }, 'Could not publish execution state to the audit trail'))
            }
        } : {})
    })
    const gatewayRuleStore = new GovernanceRuleStore()
    const ruleStores = new Map<string, GovernanceRuleStore>()
    const ruleRefreshers: GovernanceRuleRefresher[] = []
    try {
        const gatewayRuleSource = buildGatewayGovernanceRuleSource(
            config.governance.gatewayRulesDir ?? resolve(process.cwd(), 'governance/rules'),
            logger
        )
        gatewayRuleStore.swap(parseRuleDocuments(
            await gatewayRuleSource.load(), logger, gatewayRuleSource.name
        ))
        ruleRefreshers.push(new GovernanceRuleRefresher(
            gatewayRuleSource, gatewayRuleStore, config.governance.gatewayRulesRefreshSec ?? 0, logger
        ))
        for (const service of services) {
            const ruleSource = buildGovernanceRuleSource(service.governance, logger)
            const rules = new GovernanceRuleStore()
            const documents = await loadAtBoot(ruleSource, logger, service.name)
            rules.swap(parseRuleDocuments(documents, logger, ruleSource.name))
            ruleStores.set(service.name, rules)
            ruleRefreshers.push(new GovernanceRuleRefresher(
                ruleSource, rules, service.governance.rulesRefreshSec, logger
            ))
        }
    } catch (err) {
        await persistence.destroy?.()
        throw err
    }
    const retention = new ExecutionRetentionSweeper(persistence, config.retention?.executionSec ?? 0, logger)
    retention.start()
    const approvals = new ApprovalService(persistence, manager)
    for (const refresher of ruleRefreshers) refresher.start()
    const requestState = createResumeStateCodec({
        ...(config.governance.requestStateKey ? {key: config.governance.requestStateKey} : {}),
        ttlSeconds: config.governance.approvalTtlSec,
        logger
    })
    logger.info(
        {
            store: persistence.name,
            rules: {
                gateway: gatewayRuleStore.describe(),
                services: Object.fromEntries(Array.from(ruleStores, ([service, store]) => [service, store.describe()]))
            },
            defaultDecision: config.governance.defaultDecision
        },
        'Code Mode governance layer ready'
    )
    return {
        persistence, executionManager: manager, approvals,
        gatewayRules(): readonly LoadedRule[] {
            return gatewayRuleStore.getRules()
        },
        rulesForService(service: string): readonly LoadedRule[] {
            const rules = ruleStores.get(service)
            if (!rules) throw new Error(`No Governance Rule set is registered for service "${service}"`)
            return rules.getRules()
        },
        requestState, executionConfig: config,
        async shutdown() {
            retention.stop()
            for (const refresher of ruleRefreshers) refresher.stop()
            await persistence.destroy?.()
        }
    }
}

/**
 * Loads the source before startup completes (including one immediate URL GET).
 * The one tolerated failure is a file-source directory that does not exist yet:
 * that boots with no rules — every call ungoverned — and says so loudly, and a
 * later refresh picks the directory up once it appears. Anything else
 * (unreadable source, invalid rule) stops the gateway.
 */
async function loadAtBoot(
    source: GovernanceRuleSource,
    logger: Logger,
    serviceName: string
): Promise<GovernanceRuleDocument[]> {
    try {
        return await source.load()
    } catch (err) {
        if (!(err instanceof GovernanceRulesDirectoryAbsentError)) throw err
        logger.warn(
            {service: serviceName, source: source.name},
            'Service Governance Rules directory does not exist — this service has no rules (NO_GOVERNANCE)'
        )
        return []
    }
}

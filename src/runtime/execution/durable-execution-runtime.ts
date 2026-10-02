// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ExecutionConfig } from '../../core/types/config.types.js'
import type { Logger } from '../../core/types/logger.types.js'
import type { ExecutionPersistence } from '../../spi/execution/execution-store.js'
import { buildExecutionStore, buildGovernanceRuleSource } from '../../wiring/strategy-builders.js'
import { GovernanceRulesDirectoryAbsentError } from '../../spi/governance/strategies/directory-rule-source.strategy.js'
import type { GovernanceRuleDocument, GovernanceRuleSource } from '../../spi/governance/rule-source.js'
import { ExecutionManager } from './execution-manager.js'
import { ExecutionRetentionSweeper } from './execution-retention.js'
import { ApprovalService } from './approval-service.js'
import { createResumeStateCodec, type ResumeStateCodec } from './request-state.js'
import { GovernanceRuleStore } from '../governance/rule-store.js'
import { parseRuleDocuments } from '../governance/rule-loader.js'
import { GovernanceRuleRefresher } from '../governance/rule-refresher.js'
import { AuditPipeline, executionStateOf } from '../observability/audit-pipeline.js'
import { errorMessage } from '../../core/utils/errors.js'

/**
 * Everything durable execution needs at runtime, built once per
 * process (executions outlive MCP requests and V8 isolates, so none of this
 * may live in the per-request McpServer factory).
 */
export interface DurableExecutionRuntime {
  persistence: ExecutionPersistence
  executionManager: ExecutionManager
  approvals: ApprovalService
  rules: GovernanceRuleStore
  requestState: ResumeStateCodec
  executionConfig: ExecutionConfig
  shutdown(): Promise<void>
}

export async function buildDurableExecutionRuntime(config: ExecutionConfig, logger: Logger, audit?: AuditPipeline): Promise<DurableExecutionRuntime> {
  const persistence = buildExecutionStore(config.store, logger)
  const manager: ExecutionManager = new ExecutionManager(persistence, undefined, undefined, {
    ...(config.retention?.code !== undefined ? { codeRetention: config.retention.code } : {}),
    retentionSec: config.retention?.executionSec ?? 0,
    // Every persisted state change of an execution goes to the audit trail (statuses, approvals, decisions — no payloads).
    ...(audit ? {
      onStateChange: (executionId: string) => {
        void manager.inspect(executionId)
          .then(inspection => audit.publish({ kind: 'execution', state: executionStateOf(inspection) }))
          .catch(err => logger.warn({ executionId, error: errorMessage(err) }, 'Could not publish execution state to the audit trail'))
      }
    } : {})
  })
  const retention = new ExecutionRetentionSweeper(persistence, config.retention?.executionSec ?? 0, logger)
  retention.start()
  const approvals = new ApprovalService(persistence, manager)
  const rules = new GovernanceRuleStore()
  // Fail loud at boot: a source that cannot be read, or a rule that does not
  // validate, must never become "no rule". Later refreshes keep the last valid set.
  const ruleSource = buildGovernanceRuleSource(config.governance, logger)
  rules.swap(parseRuleDocuments(await loadAtBoot(ruleSource, logger), logger, ruleSource.name))
  const ruleRefresher = new GovernanceRuleRefresher(ruleSource, rules, config.governance.rulesRefreshSec ?? 0, logger)
  ruleRefresher.start()
  const requestState = createResumeStateCodec({
    ...(config.governance.requestStateKey ? { key: config.governance.requestStateKey } : {}),
    ttlSeconds: config.governance.approvalTtlSec,
    logger
  })
  logger.info(
    { store: persistence.name, rules: rules.describe(), defaultDecision: config.governance.defaultDecision },
    'Code Mode governance layer ready'
  )
  return {
    persistence, executionManager: manager, approvals, rules, requestState, executionConfig: config,
    async shutdown() {
      retention.stop()
      ruleRefresher.stop()
      await persistence.destroy?.()
    }
  }
}

/**
 * The first load. The one tolerated failure is a rules directory that does
 * not exist yet: that boots with no rules — every call ungoverned — and says
 * so loudly, and a later refresh picks the directory up once it appears.
 * Anything else (unreadable source, invalid rule) stops the gateway.
 */
async function loadAtBoot(source: GovernanceRuleSource, logger: Logger): Promise<GovernanceRuleDocument[]> {
  try {
    return await source.load()
  } catch (err) {
    if (!(err instanceof GovernanceRulesDirectoryAbsentError)) throw err
    logger.warn(
      { source: source.name },
      'Governance rules directory does not exist — no Governance Rules are loaded, so every call is ungoverned (NO_GOVERNANCE). Set GOVERNANCE_RULES_DIR.'
    )
    return []
  }
}

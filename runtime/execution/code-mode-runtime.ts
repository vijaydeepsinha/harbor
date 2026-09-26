// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { CodeModeConfig } from '../../core/types/config.types.js'
import type { Logger } from '../../core/types/logger.types.js'
import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import { buildExecutionStore, buildGovernanceRuleSource } from '../../wiring/strategy-builders.js'
import { ExecutionManager } from './execution-manager.js'
import { ApprovalService } from './approval-service.js'
import { createResumeStateCodec, type ResumeStateCodec } from './request-state.js'
import { GovernanceRuleStore } from '../governance/rule-store.js'
import { parseRuleDocuments } from '../governance/rule-loader.js'
import { GovernanceRuleRefresher } from '../governance/rule-refresher.js'

/**
 * Everything the Code Mode governance layer needs at runtime, built once per
 * process (executions outlive MCP requests and V8 isolates, so none of this
 * may live in the per-request McpServer factory).
 */
export interface CodeModeRuntime {
  store: CodeModeStore
  manager: ExecutionManager
  approvals: ApprovalService
  rules: GovernanceRuleStore
  requestState: ResumeStateCodec
  config: CodeModeConfig
  shutdown(): Promise<void>
}

export async function buildCodeModeRuntime(config: CodeModeConfig, logger: Logger): Promise<CodeModeRuntime> {
  const store = buildExecutionStore(config.store, logger)
  const manager = new ExecutionManager(store, undefined, undefined, {
    ...(config.retention?.code !== undefined ? { codeRetention: config.retention.code } : {})
  })
  const approvals = new ApprovalService(store, manager)
  const rules = new GovernanceRuleStore()
  // Fail loud at boot: a source that cannot be read, or a rule that does not
  // validate, must never become "no rule". Later refreshes keep the last valid set.
  const ruleSource = buildGovernanceRuleSource(config.governance, logger)
  rules.swap(parseRuleDocuments(await ruleSource.load(), logger, ruleSource.name))
  const ruleRefresher = new GovernanceRuleRefresher(ruleSource, rules, config.governance.rulesRefreshSec ?? 0, logger)
  ruleRefresher.start()
  const requestState = createResumeStateCodec({
    ...(config.governance.requestStateKey ? { key: config.governance.requestStateKey } : {}),
    ttlSeconds: config.governance.approvalTtlSec,
    logger
  })
  logger.info(
    { store: store.name, rules: rules.describe(), defaultDecision: config.governance.defaultDecision },
    'Code Mode governance layer ready'
  )
  return {
    store, manager, approvals, rules, requestState, config,
    async shutdown() {
      ruleRefresher.stop()
      await store.destroy?.()
    }
  }
}

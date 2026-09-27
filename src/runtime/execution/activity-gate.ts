// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ApiRequest } from '../../spi/connector/connector-api.js'
import { ERR, ACTIVITY_STATUS, type AllowedHttpMethod } from '../../core/constants.js'
import type {
  ActivityRequestRecord,
  ActivityResponseRecord,
  ApprovalSummary
} from '../../core/types/execution.types.js'
import type { ActivityJournal } from './activity-journal.js'
import type { ResolvedOperation } from '../governance/operation-resolver.js'

/**
 * What governance decided for a brand-new activity. `ALLOW` executes;
 * `DENY` stops; `REQUIRE_APPROVAL` pauses the execution on the given
 * approval. The decider persists its own decision record — the gate only
 * acts on the verdict.
 */
export type GovernanceVerdict =
  | { decision: 'ALLOW' }
  | { decision: 'DENY'; reason: string; matchedRules: string[] }
  | { decision: 'REQUIRE_APPROVAL'; approvalId: string; summary: ApprovalSummary }

/**
 * Durable-execution hooks the tool layer supplies for governed runs. Absent
 * ⇒ legacy behaviour: no journal, no replay, no governance (every existing
 * test and deployment without an execution store keeps working).
 */
export interface ExecutionBridge {
  journal: ActivityJournal
  /** Resolves a concrete call against the service's OpenAPI document. */
  resolve: (method: AllowedHttpMethod, rawPath: string) => ResolvedOperation
  /** Governance for a new activity. Absent ⇒ ALLOW (journal + replay only). */
  decide?: (sequence: number, request: ActivityRequestRecord) => Promise<GovernanceVerdict>
}

/** Why an activity may not proceed. Each one stops the run (see the bridge's run-stopping violations). */
export type ActivityStop =
  | { kind: 'approvalRequired'; sequence: number; approvalId: string; summary: ApprovalSummary }
  | { kind: 'governanceDenied'; sequence: number; reason: string; matchedRules: string[] }
  | { kind: 'cancelled'; sequence: number }
  | { kind: 'outcomeUnknown'; sequence: number; label: string }

/** The gate's answer for one encountered call. */
export type ActivityAdmission =
  /** Already COMPLETED in an earlier run: hand back the recorded response, make no external call. */
  | { kind: 'replay'; sequence: number; response: ActivityResponseRecord }
  /** Make the call. `approvalId` is set when a human approved it. */
  | { kind: 'execute'; sequence: number; request: ActivityRequestRecord; approvalId?: string }
  /** Do not make the call; `code`/`message` are what the program sees. */
  | { kind: 'stop'; stop: ActivityStop; code: string; message: string }

/** HTTP-safe methods may be re-issued after a crash mid-call; everything else fails closed. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET'])

/**
 * The single owner of durable-execution and replay *decisions* for a governed
 * run (§9–§15, §29): for each encountered call it consults the activity
 * journal — replay, execute, pause or stop — asks governance about brand-new
 * activities, and journals an admitted call as EXECUTING before it goes out.
 * The sandbox bridge only acts on its answers. Recording what then happened
 * belongs to the journal (the single source of truth), not to the gate.
 *
 * `ReplayDivergedError` from the journal propagates to the caller unchanged.
 */
export class ActivityGate {
  constructor(private readonly bridge: ExecutionBridge) {}

  get executionId(): string {
    return this.bridge.journal.executionId
  }

  resolve(method: AllowedHttpMethod, rawPath: string): ResolvedOperation {
    return this.bridge.resolve(method, rawPath)
  }

  async admit(apiRequest: ApiRequest, resolved: ResolvedOperation): Promise<ActivityAdmission> {
    const { journal } = this.bridge
    const request = toRequestRecord(apiRequest, resolved)
    const { sequence, existing } = await journal.next(request)
    const label = `${request.method} ${request.specPath}`

    if (existing) {
      switch (existing.status) {
        case ACTIVITY_STATUS.COMPLETED:
          // Replay: the recorded response stands in for the external call (Invariant 4/10).
          return { kind: 'replay', sequence, response: existing.response as ActivityResponseRecord }
        case ACTIVITY_STATUS.APPROVED:
          return { kind: 'execute', sequence, request, ...(existing.approvalId !== undefined ? { approvalId: existing.approvalId } : {}) }
        case ACTIVITY_STATUS.WAITING_APPROVAL:
          return {
            kind: 'stop',
            stop: { kind: 'approvalRequired', sequence, approvalId: existing.approvalId ?? '', summary: summaryOf(request, journal.service) },
            code: ERR.APPROVAL_REQUIRED, message: `Activity #${sequence} is waiting for approval`
          }
        case ACTIVITY_STATUS.DENIED:
          return {
            kind: 'stop', stop: { kind: 'governanceDenied', sequence, reason: 'Activity was denied', matchedRules: [] },
            code: ERR.GOVERNANCE_DENIED, message: `Activity #${sequence} was denied`
          }
        case ACTIVITY_STATUS.CANCELLED:
          return {
            kind: 'stop', stop: { kind: 'cancelled', sequence },
            code: ERR.EXECUTION_CANCELLED, message: `Activity #${sequence} was cancelled`
          }
        case ACTIVITY_STATUS.FAILED:
          return {
            kind: 'stop', stop: { kind: 'outcomeUnknown', sequence, label },
            code: ERR.ACTIVITY_OUTCOME_UNKNOWN, message: `Activity #${sequence} failed in a previous run`
          }
        case ACTIVITY_STATUS.EXECUTING:
          if (!SAFE_METHODS.has(existing.request.method)) {
            return {
              kind: 'stop', stop: { kind: 'outcomeUnknown', sequence, label },
              code: ERR.ACTIVITY_OUTCOME_UNKNOWN, message: `Activity #${sequence} was in flight when a previous run ended`
            }
          }
          return { kind: 'execute', sequence, request } // safe method: re-execute
      }
    }

    if (this.bridge.decide) {
      const verdict = await this.bridge.decide(sequence, request)
      if (verdict.decision === 'DENY') {
        await journal.recordDenied(sequence, request)
        return {
          kind: 'stop', stop: { kind: 'governanceDenied', sequence, reason: verdict.reason, matchedRules: verdict.matchedRules },
          code: ERR.GOVERNANCE_DENIED, message: `Governance denied ${label}: ${verdict.reason}`
        }
      }
      if (verdict.decision === 'REQUIRE_APPROVAL') {
        await journal.recordWaitingApproval(sequence, request, verdict.approvalId)
        return {
          kind: 'stop', stop: { kind: 'approvalRequired', sequence, approvalId: verdict.approvalId, summary: verdict.summary },
          code: ERR.APPROVAL_REQUIRED, message: `Approval required for ${label}`
        }
      }
    }
    return { kind: 'execute', sequence, request }
  }

  /**
   * Journals the call as EXECUTING — before it goes out (Invariant: journal
   * before call). How it ends (COMPLETED / FAILED) is recorded by the journal
   * itself, together with the run's other call outcomes.
   */
  async begin(admission: Extract<ActivityAdmission, { kind: 'execute' }>): Promise<void> {
    await this.bridge.journal.markExecuting(admission.sequence, admission.request, admission.approvalId)
  }
}

function toRequestRecord(apiRequest: ApiRequest, resolved: ResolvedOperation): ActivityRequestRecord {
  return {
    method: apiRequest.method,
    rawPath: apiRequest.path,
    specPath: resolved.specPath,
    ...(resolved.operationId !== undefined ? { operationId: resolved.operationId } : {}),
    ...(Object.keys(resolved.pathParams).length ? { pathParams: resolved.pathParams } : {}),
    ...(apiRequest.params !== undefined ? { query: apiRequest.params } : {}),
    ...(apiRequest.body !== undefined ? { body: apiRequest.body } : {})
  }
}

function summaryOf(request: ActivityRequestRecord, service: string): ApprovalSummary {
  return {
    service,
    method: request.method,
    specPath: request.specPath,
    ...(request.operationId !== undefined ? { operationId: request.operationId } : {}),
    ...(request.pathParams !== undefined ? { pathParams: request.pathParams } : {}),
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    reason: 'Approval pending from a previous run',
    matchedRules: []
  }
}

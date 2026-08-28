// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { governanceRuleSchema } from '../../runtime/governance/rule-schema.js'
import { loadGovernanceRules, ruleVersionTag, GovernanceRuleLoadError, type LoadedRule } from '../../runtime/governance/rule-loader.js'
import { GovernanceRuleStore } from '../../runtime/governance/rule-store.js'
import { evaluateGovernance, readField, type GovernanceRequest } from '../../runtime/governance/rule-evaluator.js'
import { GOVERNANCE_DECISION, GOVERNANCE_REASON } from '../../core/constants.js'

function rule(partial: Record<string, unknown>, source = 'r.yaml'): LoadedRule {
  const parsed = governanceRuleSchema.parse({ name: 'r', match: { service: 'trafficking' }, action: { type: 'ALLOW' }, ...partial })
  return { rule: parsed, source, contentHash: 'abcdef0123456789' }
}

const req: GovernanceRequest = {
  executionId: 'e', activitySequence: 3, service: 'trafficking', method: 'POST',
  specPath: '/campaigns', operationId: 'createCampaign', query: { dryRun: false },
  body: { budget: 1_500_000, name: 'Q4', tags: ['a', 'b'], owner: { team: 'growth' } }
}

describe('governance rule schema', () => {
  it('accepts the documented shape and defaults version to "1"', () => {
    const r = governanceRuleSchema.parse({
      name: 'high-budget-campaign', match: { service: 'trafficking', operation: 'createCampaign' },
      conditions: { budget: { greater_than: 1000000 } }, action: { type: 'REQUIRE_APPROVAL', reason: 'big' }
    })
    expect(r.version).toBe('1')
    expect(governanceRuleSchema.parse({ name: 'x', version: 3, match: { path: '/a' }, action: { type: 'DENY' } }).version).toBe('3')
  })

  it('rejects unknown keys, empty match, bad names, unknown operators and bad action types', () => {
    const base = { name: 'ok', match: { service: 's' }, action: { type: 'ALLOW' } }
    expect(governanceRuleSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, match: {} }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, name: 'Bad Name' }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, conditions: { budget: { bigger_than: 1 } } }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, conditions: { budget: {} } }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, action: { type: 'MAYBE' } }).success).toBe(false)
    expect(governanceRuleSchema.safeParse({ ...base, match: { method: 'FETCH' } }).success).toBe(false)
  })
})

describe('governance rule loader', () => {
  it('loads yaml and json files in name order, supports one/many rules per file, hashes content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-rules-'))
    try {
      writeFileSync(join(dir, '20-second.yaml'), 'name: second\nmatch: { operation: x }\naction: { type: DENY }\n')
      writeFileSync(join(dir, '10-first.json'), JSON.stringify({ rules: [
        { name: 'first-a', match: { service: 's' }, action: { type: 'ALLOW' } },
        { name: 'first-b', version: 2, match: { service: 's' }, action: { type: 'REQUIRE_APPROVAL' } }
      ] }))
      writeFileSync(join(dir, 'README.md'), 'ignored')
      const loaded = loadGovernanceRules(dir)
      expect(loaded.map(l => l.rule.name)).toEqual(['first-a', 'first-b', 'second'])
      expect(ruleVersionTag(loaded[1]!)).toMatch(/^first-b@2#[0-9a-f]{12}$/)
      expect(loaded[0]!.contentHash).toBe(loaded[1]!.contentHash) // same file
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails loud on an invalid rule, a parse error, or a duplicate name; a missing dir means no rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-rules-'))
    try {
      writeFileSync(join(dir, 'bad.yaml'), 'name: bad\nmatch: { service: s }\naction: { type: ALLOW }\ntypo_key: 1\n')
      expect(() => loadGovernanceRules(dir)).toThrow(GovernanceRuleLoadError)
      expect(() => loadGovernanceRules(dir)).toThrow(/typo_key/)
      rmSync(join(dir, 'bad.yaml'))
      writeFileSync(join(dir, 'broken.json'), '{ not json')
      expect(() => loadGovernanceRules(dir)).toThrow(/cannot parse/)
      rmSync(join(dir, 'broken.json'))
      writeFileSync(join(dir, 'a.yaml'), 'name: dup\nmatch: { service: s }\naction: { type: ALLOW }\n')
      writeFileSync(join(dir, 'b.yaml'), 'name: dup\nmatch: { service: s }\naction: { type: DENY }\n')
      expect(() => loadGovernanceRules(dir)).toThrow(/duplicate rule name "dup"/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
    expect(loadGovernanceRules(join(tmpdir(), 'definitely-missing-' + Date.now()))).toEqual([])
  })

  it('rule store swaps atomically and describes itself', () => {
    const store = new GovernanceRuleStore()
    expect(store.describe()).toEqual({ count: 0, rules: [] })
    store.swap([rule({ name: 'a' }), rule({ name: 'b', version: 4 })], '2026-01-01T00:00:00.000Z')
    expect(store.describe()).toEqual({ count: 2, loadedAt: '2026-01-01T00:00:00.000Z', rules: ['a@1#abcdef012345', 'b@4#abcdef012345'] })
  })
})

describe('governance evaluator', () => {
  it('returns the configured default with NO_MATCHING_RULE when nothing matches', () => {
    expect(evaluateGovernance([], req, GOVERNANCE_DECISION.ALLOW)).toEqual({
      decision: 'ALLOW', reason: GOVERNANCE_REASON.NO_MATCHING_RULE, matchedRules: [], ruleVersions: []
    })
    expect(evaluateGovernance([rule({ match: { service: 'other' } })], req, GOVERNANCE_DECISION.DENY).decision).toBe('DENY')
  })

  it('matches on service / operation / method / path with * wildcards, all clauses ANDed', () => {
    const hit = (match: Record<string, unknown>) =>
      evaluateGovernance([rule({ name: 'r', match, action: { type: 'DENY' } })], req, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
    expect(hit({ service: 'trafficking' })).toBe(true)
    expect(hit({ operation: 'createCampaign' })).toBe(true)
    expect(hit({ operation: '*' })).toBe(true)
    expect(hit({ method: 'POST', path: '/campaigns' })).toBe(true)
    expect(hit({ method: 'GET', path: '/campaigns' })).toBe(false)
    expect(hit({ service: 'trafficking', operation: 'listCampaigns' })).toBe(false)
    expect(hit({ path: '/campaigns/{id}' })).toBe(false)
    // an operation wildcard needs an operationId to exist
    expect(evaluateGovernance([rule({ match: { operation: '*' }, action: { type: 'DENY' } })],
      { ...req, operationId: undefined }, GOVERNANCE_DECISION.ALLOW).decision).toBe('ALLOW')
  })

  it('reads bare fields from the body and explicit body./query./path. prefixes', () => {
    expect(readField(req, 'budget')).toBe(1_500_000)
    expect(readField(req, 'body.owner.team')).toBe('growth')
    expect(readField(req, 'query.dryRun')).toBe(false)
    expect(readField({ ...req, pathParams: { id: 'C1' } }, 'path.id')).toBe('C1')
    expect(readField(req, 'body.tags.1')).toBe('b')
    expect(readField(req, 'missing.deep')).toBeUndefined()
  })

  it('evaluates every operator; missing fields only satisfy exists:false; type mismatches are false', () => {
    const holds = (conditions: Record<string, unknown>) =>
      evaluateGovernance([rule({ conditions, action: { type: 'DENY' } })], req, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
    expect(holds({ budget: { greater_than: 1_000_000 } })).toBe(true)
    expect(holds({ budget: { greater_than: 2_000_000 } })).toBe(false)
    expect(holds({ budget: { greater_than_or_equal: 1_500_000, less_than_or_equal: 1_500_000 } })).toBe(true)
    expect(holds({ budget: { less_than: 1_500_000 } })).toBe(false)
    expect(holds({ name: { equals: 'Q4' } })).toBe(true)
    expect(holds({ name: { not_equals: 'Q4' } })).toBe(false)
    expect(holds({ name: { in: ['Q3', 'Q4'] } })).toBe(true)
    expect(holds({ name: { not_in: ['Q3', 'Q4'] } })).toBe(false)
    expect(holds({ name: { starts_with: 'Q' } })).toBe(true)
    expect(holds({ name: { contains: '4' } })).toBe(true)
    expect(holds({ tags: { contains: 'b' } })).toBe(true)
    expect(holds({ tags: { contains: 'z' } })).toBe(false)
    expect(holds({ 'query.dryRun': { equals: false } })).toBe(true)
    expect(holds({ nothing: { exists: false } })).toBe(true)
    expect(holds({ nothing: { exists: true } })).toBe(false)
    expect(holds({ nothing: { greater_than: 1 } })).toBe(false)
    expect(holds({ name: { greater_than: 1 } })).toBe(false) // string vs number comparison never holds
    expect(holds({ budget: { exists: true, greater_than: 1 } })).toBe(true)
  })

  it('applies DENY > REQUIRE_APPROVAL > ALLOW among conflicting matches and names the deciding rule', () => {
    const rules = [
      rule({ name: 'allow-all', action: { type: 'ALLOW' } }, 'a.yaml'),
      rule({ name: 'needs-approval', version: 7, conditions: { budget: { greater_than: 1 } }, action: { type: 'REQUIRE_APPROVAL', reason: 'big spend' } }, 'b.yaml'),
      rule({ name: 'not-matching', match: { service: 'zzz' }, action: { type: 'DENY' } }, 'c.yaml')
    ]
    const out = evaluateGovernance(rules, req, GOVERNANCE_DECISION.ALLOW)
    expect(out).toEqual({
      decision: 'REQUIRE_APPROVAL', reason: 'big spend', decidingRule: 'needs-approval',
      matchedRules: ['allow-all', 'needs-approval'],
      ruleVersions: ['allow-all@1#abcdef012345', 'needs-approval@7#abcdef012345']
    })
    const withDeny = [...rules, rule({ name: 'hard-stop', action: { type: 'DENY' } }, 'd.yaml')]
    const denied = evaluateGovernance(withDeny, req, GOVERNANCE_DECISION.ALLOW)
    expect(denied.decision).toBe('DENY')
    expect(denied.decidingRule).toBe('hard-stop')
    expect(denied.reason).toBe(`${GOVERNANCE_REASON.RULE_MATCHED}: hard-stop`)
    // two rules with the same winning action: the first in file order decides
    const twoDeny = [rule({ name: 'd-later', action: { type: 'DENY' } }, 'z.yaml'), rule({ name: 'd-first', action: { type: 'DENY' } }, 'a.yaml')]
    expect(evaluateGovernance(twoDeny, req, GOVERNANCE_DECISION.ALLOW).decidingRule).toBe('d-later')
  })

  it('fails closed to DENY when evaluation itself throws', () => {
    const poison = { rule: Object.defineProperty({ ...rule({}).rule }, 'match', { get() { throw new Error('boom') } }), source: 'x', contentHash: 'h' } as LoadedRule
    const out = evaluateGovernance([poison], req, GOVERNANCE_DECISION.ALLOW)
    expect(out.decision).toBe('DENY')
    expect(out.reason).toContain(GOVERNANCE_REASON.EVALUATION_FAILED)
  })
})

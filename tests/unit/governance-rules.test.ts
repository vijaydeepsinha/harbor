// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { governanceRuleSchema, MAX_CONDITION_DEPTH, MAX_CONDITION_NODES } from '../../runtime/governance/rule-schema.js'
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

describe('governance rule schema — condition tree (allOf / anyOf / not) and computed operands', () => {
  const base = { name: 'ok', match: { service: 's' }, action: { type: 'ALLOW' } }
  const conditionsOf = (conditions: unknown) => governanceRuleSchema.parse({ ...base, conditions }).conditions
  const errorsOf = (conditions: unknown) => {
    const r = governanceRuleSchema.safeParse({ ...base, conditions })
    return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
  }

  it('normalises a tree: each node gets its kind, leaves keep their operand and operators', () => {
    expect(conditionsOf({
      allOf: [
        { field: 'body.channel', in: ['tv', 'radio'] },
        { anyOf: [{ ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, greater_than: 1.3 }, { not: { field: 'query.dryRun', equals: true } }] }
      ]
    })).toEqual({
      kind: 'allOf',
      allOf: [
        { kind: 'leaf', field: 'body.channel', in: ['tv', 'radio'] },
        { kind: 'anyOf', anyOf: [
          { kind: 'leaf', ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, greater_than: 1.3 },
          { kind: 'not', not: { kind: 'leaf', field: 'query.dryRun', equals: true } }
        ] }
      ]
    })
    // a single leaf is a valid tree too, and parsing a normalised tree again is a no-op
    const leaf = conditionsOf({ days_between: { from: 'body.startDate', to: 'body.endDate' }, equals: 30 })
    expect(leaf).toEqual({ kind: 'leaf', days_between: { from: 'body.startDate', to: 'body.endDate' }, equals: 30 })
    expect(conditionsOf(leaf)).toEqual(leaf)
  })

  it('accepts the flat form as shorthand for allOf; an empty flat map means no conditions', () => {
    expect(conditionsOf({ budget: { greater_than: 1000 }, 'query.dryRun': { not_equals: true } })).toEqual({
      kind: 'allOf',
      allOf: [
        { kind: 'leaf', field: 'budget', greater_than: 1000 },
        { kind: 'leaf', field: 'query.dryRun', not_equals: true }
      ]
    })
    // `kind` is Harbor's node tag, but in the flat form it is just a body field
    expect(conditionsOf({ kind: { equals: 'video' } })).toEqual({ kind: 'allOf', allOf: [{ kind: 'leaf', field: 'kind', equals: 'video' }] })
    expect(conditionsOf({})).toBeUndefined()
    expect(governanceRuleSchema.parse(base).conditions).toBeUndefined()
  })

  it.each([
    ['a leaf without an operand', { allOf: [{ equals: 1 }] }, 'conditions.allOf.0: a condition reads exactly one of field, ratio, percent_of, days_between'],
    ['a leaf with two operands', { field: 'a', ratio: { numerator: 'b', denominator: 'c' }, equals: 1 }, 'conditions: a condition reads exactly one of'],
    ['a leaf without an operator', { field: 'a' }, 'conditions: a condition needs at least one operator'],
    ['an unknown operator', { anyOf: [{ field: 'a', bigger_than: 1 }] }, 'conditions.anyOf.0: Unrecognized key: "bigger_than"'],
    ['a misspelt computed operand key', { ratio: { numerator: 'a', denominater: 'b' }, greater_than: 1 }, 'conditions.ratio'],
    ['an empty allOf', { allOf: [] }, 'conditions.allOf: Too small'],
    ['a not holding a list', { not: [{ field: 'a', equals: 1 }] }, 'conditions.not'],
    ['two composites in one node', { allOf: [{ field: 'a', equals: 1 }], anyOf: [{ field: 'b', equals: 2 }] }, 'conditions: Unrecognized key: "anyOf"'],
    ['a string operator on a computed number', { percent_of: { part: 'a', whole: 'b' }, starts_with: '2' }, 'conditions.starts_with: percent_of yields a number'],
    ['a non-number value on a computed number', { days_between: { from: 'a', to: 'b' }, equals: '30' }, 'conditions.equals: days_between yields a number'],
    ['a non-number list on a computed number', { ratio: { numerator: 'a', denominator: 'b' }, in: [1, 'two'] }, 'conditions.in: ratio yields a number']
  ])('rejects %s at load, naming the exact place', (_label, conditions, expected) => {
    const errors = errorsOf(conditions)
    expect(errors.some(e => e.startsWith(expected))).toBe(true)
  })

  it('bounds the tree: at most MAX_CONDITION_DEPTH levels and MAX_CONDITION_NODES nodes', () => {
    const leaf = { field: 'a', equals: 1 }
    let deep: unknown = leaf
    for (let i = 1; i < MAX_CONDITION_DEPTH; i++) deep = { not: deep }
    expect(errorsOf(deep)).toEqual([])
    expect(errorsOf({ not: deep })).toEqual([`conditions: conditions nest ${MAX_CONDITION_DEPTH + 1} levels deep; the limit is ${MAX_CONDITION_DEPTH}`])
    expect(errorsOf({ anyOf: Array.from({ length: MAX_CONDITION_NODES - 1 }, () => leaf) })).toEqual([])
    expect(errorsOf({ anyOf: Array.from({ length: MAX_CONDITION_NODES }, () => leaf) })).toEqual([`conditions: conditions have ${MAX_CONDITION_NODES + 1} nodes; the limit is ${MAX_CONDITION_NODES}`])
  })

  it('keeps the action advisory: only ALLOW | DENY | REQUIRE_APPROVAL plus a reason — no mutation, no side effect', () => {
    for (const action of [
      { type: 'ALLOW', set: { 'body.budget': 0 } },
      { type: 'REQUIRE_APPROVAL', reason: 'r', mutate: { body: {} } },
      { type: 'DENY', notify: 'ops@example.com' },
      { type: 'REWRITE', reason: 'r' }
    ]) {
      expect(governanceRuleSchema.safeParse({ ...base, action }).success).toBe(false)
    }
    expect(governanceRuleSchema.parse({ ...base, action: { type: 'DENY', reason: 'no' } }).action).toEqual({ type: 'DENY', reason: 'no' })
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

  it('loads condition trees and reports a bad nested node with its file, rule and exact path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harbor-rules-'))
    try {
      writeFileSync(join(dir, 'tree.yaml'), [
        'name: big-share',
        'match: { service: trafficking, operation: createCampaign }',
        'conditions:',
        '  allOf:',
        '    - percent_of: { part: body.budget, whole: body.totalBudget }',
        '      greater_than: 20',
        '    - not: { field: query.dryRun, equals: true }',
        'action: { type: REQUIRE_APPROVAL, reason: Large share of the total budget }',
        ''
      ].join('\n'))
      const [loaded] = loadGovernanceRules(dir)
      expect(loaded?.rule.conditions).toMatchObject({ kind: 'allOf', allOf: [{ kind: 'leaf' }, { kind: 'not' }] })

      writeFileSync(join(dir, 'tree.yaml'), [
        'rules:',
        '  - name: fine',
        '    match: { service: s }',
        '    action: { type: ALLOW }',
        '  - name: broken',
        '    match: { service: s }',
        '    conditions:',
        '      anyOf:',
        '        - field: body.a',
        '          equals: 1',
        '        - ratio: { numerator: body.a, denominator: body.b }',
        '          starts_with: x',
        '    action: { type: DENY }',
        ''
      ].join('\n'))
      expect(() => loadGovernanceRules(dir)).toThrow(/tree\.yaml \(rule 2\): invalid Governance Rule — conditions\.anyOf\.1\.starts_with: ratio yields a number/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
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

  describe('condition tree and computed operands', () => {
    const campaign = (body: Record<string, unknown>, query: Record<string, unknown> = {}): GovernanceRequest =>
      ({ ...req, body, query })
    const decide = (conditions: unknown, request: GovernanceRequest) =>
      evaluateGovernance([rule({ conditions, action: { type: 'REQUIRE_APPROVAL' } })], request, GOVERNANCE_DECISION.ALLOW).decision

    it('"budget > 20% of total budget" — percent_of', () => {
      const c = { percent_of: { part: 'body.budget', whole: 'body.totalBudget' }, greater_than: 20 }
      expect(decide(c, campaign({ budget: 25_000, totalBudget: 100_000 }))).toBe('REQUIRE_APPROVAL')
      expect(decide(c, campaign({ budget: 20_000, totalBudget: 100_000 }))).toBe('ALLOW') // exactly 20% is not > 20%
      expect(decide(c, campaign({ budget: 21, totalBudget: 100 }))).toBe('REQUIRE_APPROVAL')
    })

    it('"bid > 1.3x current bid" — ratio', () => {
      const c = { ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, greater_than: 1.3 }
      expect(decide(c, campaign({ bid: 131, currentBid: 100 }))).toBe('REQUIRE_APPROVAL')
      expect(decide(c, campaign({ bid: 130, currentBid: 100 }))).toBe('ALLOW') // exactly 1.3x
      // computed values are rounded, so float noise never flips a boundary: 1.43 / 1.1 is 1.3, 100 × 1.1 is 110
      expect(decide({ ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, equals: 1.3 }, campaign({ bid: 1.43, currentBid: 1.1 }))).toBe('REQUIRE_APPROVAL')
      expect(decide({ percent_of: { part: 'body.budget', whole: 'body.totalBudget' }, greater_than: 110 }, campaign({ budget: 1.1, totalBudget: 1 }))).toBe('ALLOW')
    })

    it('"endDate is 30 days after startDate" — days_between with ISO dates and zoned date-times', () => {
      const c = { days_between: { from: 'body.startDate', to: 'body.endDate' }, equals: 30 }
      expect(decide(c, campaign({ startDate: '2026-03-01', endDate: '2026-03-31' }))).toBe('REQUIRE_APPROVAL')
      expect(decide(c, campaign({ startDate: '2026-03-01', endDate: '2026-03-30' }))).toBe('ALLOW')
      expect(decide(c, campaign({ startDate: '2026-03-01T00:00:00Z', endDate: '2026-03-31T05:30:00+05:30' }))).toBe('REQUIRE_APPROVAL')
      expect(decide({ days_between: { from: 'body.startDate', to: 'body.endDate' }, less_than: 0 },
        campaign({ startDate: '2026-03-31', endDate: '2026-03-01' }))).toBe('REQUIRE_APPROVAL') // end before start is negative
    })

    it('a computed operand that cannot be computed is treated like a missing field', () => {
      const ratio = { ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, greater_than: 0 }
      const days = { days_between: { from: 'body.startDate', to: 'body.endDate' }, greater_than: -1_000_000 }
      for (const [c, body] of [
        [ratio, { bid: 5, currentBid: 0 }],                      // division by zero
        [ratio, { bid: '5', currentBid: 1 }],                    // not a number
        [ratio, { currentBid: 1 }],                              // missing
        [days, { startDate: '2026-02-30', endDate: '2026-03-31' }],            // not a calendar date (JS would roll it to March 2)
        [days, { startDate: '2026-03-01T10:00:00', endDate: '2026-03-31' }],   // date-time without a zone: host-dependent, refused
        [days, { startDate: '01/03/2026', endDate: '2026-03-31' }]             // not ISO 8601
      ] as const) {
        expect(decide(c, campaign(body))).toBe('ALLOW')
      }
      expect(decide({ ratio: { numerator: 'body.bid', denominator: 'body.currentBid' }, exists: false }, campaign({ bid: 5, currentBid: 0 }))).toBe('REQUIRE_APPROVAL')
    })

    it('allOf = AND, anyOf = OR, not = NOT, nested', () => {
      const c = {
        allOf: [
          { field: 'body.channel', in: ['tv', 'radio'] },
          { anyOf: [{ field: 'body.priority', equals: 'high' }, { not: { field: 'query.dryRun', equals: true } }] }
        ]
      }
      expect(decide(c, campaign({ channel: 'tv', priority: 'low' }, { dryRun: false }))).toBe('REQUIRE_APPROVAL')
      expect(decide(c, campaign({ channel: 'tv', priority: 'high' }, { dryRun: true }))).toBe('REQUIRE_APPROVAL')
      expect(decide(c, campaign({ channel: 'tv', priority: 'low' }, { dryRun: true }))).toBe('ALLOW')   // anyOf fails
      expect(decide(c, campaign({ channel: 'web', priority: 'high' }, { dryRun: false }))).toBe('ALLOW') // allOf fails
      expect(decide({ not: { field: 'body.missing', exists: true } }, campaign({}))).toBe('REQUIRE_APPROVAL')
    })

    it('the flat form decides exactly like its allOf tree', () => {
      const flat = { budget: { greater_than: 1000 }, 'query.dryRun': { not_equals: true }, name: { starts_with: 'Q' } }
      const tree = { allOf: [
        { field: 'budget', greater_than: 1000 },
        { field: 'query.dryRun', not_equals: true },
        { field: 'name', starts_with: 'Q' }
      ] }
      for (const [body, query] of [
        [{ budget: 5000, name: 'Q4' }, { dryRun: false }],
        [{ budget: 5000, name: 'Q4' }, { dryRun: true }],
        [{ budget: 10, name: 'Q4' }, {}],
        [{ budget: 5000, name: 'H1' }, {}],
        [{ name: 'Q4' }, {}]
      ] as const) {
        expect(decide(flat, campaign(body, query))).toBe(decide(tree, campaign(body, query)))
      }
    })
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

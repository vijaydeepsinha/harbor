// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
    governanceRuleSchema,
    MAX_CONDITION_DEPTH,
    MAX_CONDITION_NODES
} from '../../src/runtime/governance/rule-schema.js'
import {
    GovernanceRuleLoadError,
    type LoadedRule,
    loadGovernanceRules,
    ruleVersionTag
} from '../../src/runtime/governance/rule-loader.js'
import {GovernanceRuleStore} from '../../src/runtime/governance/rule-store.js'
import {
    evaluateGovernance,
    type GovernanceRequest,
    readField,
    ruleLevel
} from '../../src/runtime/governance/rule-evaluator.js'
import {GOVERNANCE_DECISION, GOVERNANCE_REASON, RULE_LEVEL} from '../../src/core/constants.js'
import {campaignSpec} from './code-mode-harness.js'

function rule(partial: Record<string, unknown>, source = 'r.yaml'): LoadedRule {
    const parsed = governanceRuleSchema.parse({
        name: 'r',
        match: {service: 'trafficking'},
        action: {type: 'ALLOW'}, ...partial
    })
    return {rule: parsed, source, contentHash: 'abcdef0123456789'}
}

const req: GovernanceRequest = {
    executionId: 'e', activitySequence: 3, service: 'trafficking', method: 'POST',
    specPath: '/campaigns', operationId: 'createCampaign', query: {dryRun: false},
    body: {budget: 1_500_000, name: 'Q4', tags: ['a', 'b'], owner: {team: 'growth'}}
}

describe('governance rule schema', () => {
    it('accepts the documented shape and defaults version to "1"', () => {
        const r = governanceRuleSchema.parse({
            name: 'high-budget-campaign', match: {service: 'trafficking', operation: 'createCampaign'},
            conditions: {budget: {greater_than: 1000000}}, action: {type: 'REQUIRE_APPROVAL', reason: 'big'}
        })
        expect(r.version).toBe('1')
        expect(governanceRuleSchema.parse({
            name: 'x',
            version: 3,
            match: {path: '/a'},
            action: {type: 'DENY'}
        }).version).toBe('3')
    })

    it('rejects unknown keys, empty match, bad names, unknown operators and bad action types', () => {
        const base = {name: 'ok', match: {service: 's'}, action: {type: 'ALLOW'}}
        expect(governanceRuleSchema.safeParse({...base, extra: 1}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, match: {}}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, name: 'Bad Name'}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, conditions: {budget: {bigger_than: 1}}}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, conditions: {budget: {}}}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, action: {type: 'MAYBE'}}).success).toBe(false)
        expect(governanceRuleSchema.safeParse({...base, match: {method: 'FETCH'}}).success).toBe(false)
    })
})

describe('governance rule schema — condition tree (allOf / anyOf / not) and computed operands', () => {
    const base = {name: 'ok', match: {service: 's'}, action: {type: 'ALLOW'}}
    const conditionsOf = (conditions: unknown) => governanceRuleSchema.parse({...base, conditions}).conditions
    const errorsOf = (conditions: unknown) => {
        const r = governanceRuleSchema.safeParse({...base, conditions})
        return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    }

    it('normalises a tree: each node gets its kind, leaves keep their operand and operators', () => {
        expect(conditionsOf({
            allOf: [
                {field: 'body.channel', in: ['tv', 'radio']},
                {
                    anyOf: [{
                        ratio: {numerator: 'body.bid', denominator: 'body.currentBid'},
                        greater_than: 1.3
                    }, {not: {field: 'query.dryRun', equals: true}}]
                }
            ]
        })).toEqual({
            kind: 'allOf',
            allOf: [
                {kind: 'leaf', field: 'body.channel', in: ['tv', 'radio']},
                {
                    kind: 'anyOf', anyOf: [
                        {
                            kind: 'leaf',
                            ratio: {numerator: 'body.bid', denominator: 'body.currentBid'},
                            greater_than: 1.3
                        },
                        {kind: 'not', not: {kind: 'leaf', field: 'query.dryRun', equals: true}}
                    ]
                }
            ]
        })
        // a single leaf is a valid tree too, and parsing a normalised tree again is a no-op
        const leaf = conditionsOf({days_between: {from: 'body.startDate', to: 'body.endDate'}, equals: 30})
        expect(leaf).toEqual({kind: 'leaf', days_between: {from: 'body.startDate', to: 'body.endDate'}, equals: 30})
        expect(conditionsOf(leaf)).toEqual(leaf)
    })

    it('accepts the flat form as shorthand for allOf; an empty flat map means no conditions', () => {
        expect(conditionsOf({budget: {greater_than: 1000}, 'query.dryRun': {not_equals: true}})).toEqual({
            kind: 'allOf',
            allOf: [
                {kind: 'leaf', field: 'budget', greater_than: 1000},
                {kind: 'leaf', field: 'query.dryRun', not_equals: true}
            ]
        })
        // `kind` is Harbor's node tag, but in the flat form it is just a body field
        expect(conditionsOf({kind: {equals: 'video'}})).toEqual({
            kind: 'allOf',
            allOf: [{kind: 'leaf', field: 'kind', equals: 'video'}]
        })
        expect(conditionsOf({})).toBeUndefined()
        expect(governanceRuleSchema.parse(base).conditions).toBeUndefined()
    })

    it.each([
        ['a leaf without an operand', {allOf: [{equals: 1}]}, 'conditions.allOf.0: a condition reads exactly one of field, ratio, percent_of, days_between'],
        ['a leaf with two operands', {
            field: 'a',
            ratio: {numerator: 'b', denominator: 'c'},
            equals: 1
        }, 'conditions: a condition reads exactly one of'],
        ['a leaf without an operator', {field: 'a'}, 'conditions: a condition needs at least one operator'],
        ['an unknown operator', {
            anyOf: [{
                field: 'a',
                bigger_than: 1
            }]
        }, 'conditions.anyOf.0: Unrecognized key: "bigger_than"'],
        ['a misspelt computed operand key', {
            ratio: {numerator: 'a', denominater: 'b'},
            greater_than: 1
        }, 'conditions.ratio'],
        ['an empty allOf', {allOf: []}, 'conditions.allOf: Too small'],
        ['a not holding a list', {not: [{field: 'a', equals: 1}]}, 'conditions.not'],
        ['two composites in one node', {
            allOf: [{field: 'a', equals: 1}],
            anyOf: [{field: 'b', equals: 2}]
        }, 'conditions: Unrecognized key: "anyOf"'],
        ['a string operator on a computed number', {
            percent_of: {part: 'a', whole: 'b'},
            starts_with: '2'
        }, 'conditions.starts_with: percent_of yields a number'],
        ['a non-number value on a computed number', {
            days_between: {from: 'a', to: 'b'},
            equals: '30'
        }, 'conditions.equals: days_between yields a number'],
        ['a non-number list on a computed number', {
            ratio: {numerator: 'a', denominator: 'b'},
            in: [1, 'two']
        }, 'conditions.in: ratio yields a number']
    ])('rejects %s at load, naming the exact place', (_label, conditions, expected) => {
        const errors = errorsOf(conditions)
        expect(errors.some(e => e.startsWith(expected))).toBe(true)
    })

    it('bounds the tree: at most MAX_CONDITION_DEPTH levels and MAX_CONDITION_NODES nodes', () => {
        const leaf = {field: 'a', equals: 1}
        let deep: unknown = leaf
        for (let i = 1; i < MAX_CONDITION_DEPTH; i++) deep = {not: deep}
        expect(errorsOf(deep)).toEqual([])
        expect(errorsOf({not: deep})).toEqual([`conditions: conditions nest ${MAX_CONDITION_DEPTH + 1} levels deep; the limit is ${MAX_CONDITION_DEPTH}`])
        expect(errorsOf({anyOf: Array.from({length: MAX_CONDITION_NODES - 1}, () => leaf)})).toEqual([])
        expect(errorsOf({anyOf: Array.from({length: MAX_CONDITION_NODES}, () => leaf)})).toEqual([`conditions: conditions have ${MAX_CONDITION_NODES + 1} nodes; the limit is ${MAX_CONDITION_NODES}`])
    })

    it('bounds the flat shorthand by the tree it stands for: no more than MAX_CONDITION_NODES - 1 fields', () => {
        const flat = (n: number) => Object.fromEntries(Array.from({length: n}, (_, i) => [`body.f${i}`, {equals: i}]))
        expect(errorsOf(flat(MAX_CONDITION_NODES - 1))).toEqual([]) // allOf + 63 leaves = 64 nodes
        expect(errorsOf(flat(MAX_CONDITION_NODES))).toEqual([`conditions: conditions have ${MAX_CONDITION_NODES + 1} nodes; the limit is ${MAX_CONDITION_NODES}`])
        expect(errorsOf(flat(1000))).toHaveLength(1)
    })

    it('keeps the action advisory: only ALLOW | DENY | REQUIRE_APPROVAL plus a reason — no mutation, no side effect', () => {
        for (const action of [
            {type: 'ALLOW', set: {'body.budget': 0}},
            {type: 'REQUIRE_APPROVAL', reason: 'r', mutate: {body: {}}},
            {type: 'DENY', notify: 'ops@example.com'},
            {type: 'REWRITE', reason: 'r'}
        ]) {
            expect(governanceRuleSchema.safeParse({...base, action}).success).toBe(false)
        }
        expect(governanceRuleSchema.parse({
            ...base,
            action: {type: 'DENY', reason: 'no'}
        }).action).toEqual({type: 'DENY', reason: 'no'})
    })
})

describe('governance rule loader', () => {
    it('loads yaml and json files in name order, supports one/many rules per file, hashes content', () => {
        const dir = mkdtempSync(join(tmpdir(), 'harbor-rules-'))
        try {
            writeFileSync(join(dir, '20-second.yaml'), 'name: second\nmatch: { operation: x }\naction: { type: DENY }\n')
            writeFileSync(join(dir, '10-first.json'), JSON.stringify({
                rules: [
                    {name: 'first-a', match: {service: 's'}, action: {type: 'ALLOW'}},
                    {name: 'first-b', version: 2, match: {service: 's'}, action: {type: 'REQUIRE_APPROVAL'}}
                ]
            }))
            writeFileSync(join(dir, 'README.md'), 'ignored')
            const loaded = loadGovernanceRules(dir)
            expect(loaded.map(l => l.rule.name)).toEqual(['first-a', 'first-b', 'second'])
            expect(ruleVersionTag(loaded[1]!)).toMatch(/^first-b@2#[0-9a-f]{12}$/)
            expect(loaded[0]!.contentHash).toBe(loaded[1]!.contentHash) // same file
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
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
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
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
            expect(loaded?.rule.conditions).toMatchObject({kind: 'allOf', allOf: [{kind: 'leaf'}, {kind: 'not'}]})

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
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    it('the documented order service examples load', () => {
        const loaded = loadGovernanceRules(join(process.cwd(), 'governance/rules/examples'))
        expect(loaded.map(l => l.rule.name)).toEqual([
            'high-value-order',
            'usd-order-review',
            'expensive-first-item',
            'complex-order-review',
            'order-service-baseline'
        ])
    })

    it('the separate gateway example is final across services', () => {
        const gatewayRules = loadGovernanceRules(join(process.cwd(), 'governance/rules/examples/gateway'))
        const serviceAllow = rule({
            name: 'allow-orders',
            match: {service: 'orders'},
            action: {type: 'ALLOW'}
        })
        const outcome = evaluateGovernance({
            gatewayRules,
            serviceRules: [serviceAllow]
        }, {
            executionId: 'e',
            activitySequence: 1,
            service: 'orders',
            method: 'DELETE',
            specPath: '/orders',
            query: {all: true}
        }, GOVERNANCE_DECISION.DENY)

        expect(outcome).toMatchObject({
            decision: GOVERNANCE_DECISION.DENY,
            decidingRule: 'gateway/no-bulk-deletes-anywhere'
        })
    })

    it('the order examples demonstrate thresholds, item limits, and AND/OR/NOT logic', () => {
        const examples = loadGovernanceRules(join(process.cwd(), 'governance/rules/examples'))
        const order = (
            body: Record<string, unknown>,
            query?: Record<string, unknown>
        ): GovernanceRequest => ({
            executionId: 'e',
            activitySequence: 1,
            service: 'order',
            method: 'POST',
            specPath: '/orders',
            operationId: 'placeOrder',
            ...(query !== undefined ? {query} : {}),
            body
        })
        const decide = (body: Record<string, unknown>, query?: Record<string, unknown>) =>
            evaluateGovernance({
                gatewayRules: [],
                serviceRules: examples
            }, order(body, query), GOVERNANCE_DECISION.DENY)

        expect(decide({amount: 1200, currency: 'EUR', items: [{unitPrice: 100}]})).toMatchObject({
            decision: 'REQUIRE_APPROVAL',
            decidingRule: 'order/high-value-order'
        })
        expect(decide({amount: 100, currency: 'USD', items: [{unitPrice: 25}]})).toMatchObject({
            decision: 'REQUIRE_APPROVAL',
            decidingRule: 'order/usd-order-review'
        })
        expect(decide({amount: 100, currency: 'EUR', items: [{unitPrice: 600}]})).toMatchObject({
            decision: 'DENY',
            decidingRule: 'order/expensive-first-item'
        })
        expect(decide(
            {amount: 100, currency: 'EUR', items: [{unitPrice: 300}]}
        )).toMatchObject({
            decision: 'REQUIRE_APPROVAL',
            decidingRule: 'order/complex-order-review'
        })
        expect(decide(
            {amount: 100, currency: 'EUR', items: [{unitPrice: 300}]},
            {preApproved: 'true'}
        )).toMatchObject({
            decision: 'ALLOW',
            decidingRule: 'order/order-service-baseline'
        })
        expect(decide(
            {amount: 800, currency: 'EUR', items: [{unitPrice: 100}]}
        )).toMatchObject({
            decision: 'REQUIRE_APPROVAL',
            decidingRule: 'order/complex-order-review'
        })
    })

    it('rule store swaps atomically and describes itself', () => {
        const store = new GovernanceRuleStore()
        expect(store.describe()).toEqual({count: 0, rules: []})
        store.swap([rule({name: 'a'}), rule({name: 'b', version: 4})], '2026-01-01T00:00:00.000Z')
        expect(store.describe()).toEqual({
            count: 2,
            loadedAt: '2026-01-01T00:00:00.000Z',
            rules: ['a@1#abcdef012345', 'b@4#abcdef012345']
        })
    })
})

describe('governance evaluator', () => {
    it('a call no rule targets is ungoverned: ALLOW (NO_GOVERNANCE), whatever the default', () => {
        for (const defaultDecision of [GOVERNANCE_DECISION.DENY, GOVERNANCE_DECISION.REQUIRE_APPROVAL, GOVERNANCE_DECISION.ALLOW]) {
            const ungoverned = {
                decision: 'ALLOW',
                reason: GOVERNANCE_REASON.NO_GOVERNANCE,
                matchedRules: [],
                ruleVersions: []
            }
            expect(evaluateGovernance([], req, defaultDecision)).toEqual(ungoverned)
            expect(evaluateGovernance([rule({
                match: {service: 'other'},
                action: {type: 'DENY'}
            })], req, defaultDecision)).toEqual(ungoverned)
        }
    })

    it('a call some rule targets but none matches gets the configured default (NO_MATCHING_RULE)', () => {
        const conditional = rule({
            match: {service: 'trafficking', operation: 'createCampaign'},
            conditions: {budget: {greater_than: 5_000_000}},
            action: {type: 'REQUIRE_APPROVAL'}
        })
        expect(evaluateGovernance([conditional], req, GOVERNANCE_DECISION.DENY)).toEqual({
            decision: 'DENY', reason: GOVERNANCE_REASON.NO_MATCHING_RULE, matchedRules: [], ruleVersions: []
        })
        expect(evaluateGovernance([conditional], req, GOVERNANCE_DECISION.ALLOW).decision).toBe('ALLOW')
    })

    it('targeting follows match only: a subtree or a gateway method rule targets every call it covers', () => {
        const subtree = rule({
            match: {path: '/campaigns/**'},
            conditions: {'body.force': {equals: true}},
            action: {type: 'ALLOW'}
        })
        const deletes = rule({
            name: 'deletes',
            match: {method: 'DELETE'},
            conditions: {'query.confirm': {equals: true}},
            action: {type: 'ALLOW'}
        })
        const decide = (r: LoadedRule, request: GovernanceRequest) => evaluateGovernance([r], request, GOVERNANCE_DECISION.DENY)
        // /campaigns/{id}/finalize is under the subtree: targeted, condition false ⇒ default DENY
        expect(decide(subtree, {...req, specPath: '/campaigns/{id}/finalize'})).toMatchObject({
            decision: 'DENY',
            reason: GOVERNANCE_REASON.NO_MATCHING_RULE
        })
        // /orders is not ⇒ ungoverned
        expect(decide(subtree, {...req, specPath: '/orders'})).toMatchObject({
            decision: 'ALLOW',
            reason: GOVERNANCE_REASON.NO_GOVERNANCE
        })
        // every DELETE on every service is targeted by the gateway rule; a POST is not
        expect(decide(deletes, {
            ...req,
            service: 'billing',
            method: 'DELETE'
        }).reason).toBe(GOVERNANCE_REASON.NO_MATCHING_RULE)
        expect(decide(deletes, req).reason).toBe(GOVERNANCE_REASON.NO_GOVERNANCE)
    })

    it('matches on service / operation / method / path with * wildcards, all clauses ANDed', () => {
        const hit = (match: Record<string, unknown>) =>
            evaluateGovernance([rule({
                name: 'r',
                match,
                action: {type: 'DENY'}
            })], req, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        expect(hit({service: 'trafficking'})).toBe(true)
        expect(hit({operation: 'createCampaign'})).toBe(true)
        expect(hit({operation: '*'})).toBe(true)
        expect(hit({method: 'POST', path: '/campaigns'})).toBe(true)
        expect(hit({method: 'GET', path: '/campaigns'})).toBe(false)
        expect(hit({service: 'trafficking', operation: 'listCampaigns'})).toBe(false)
        expect(hit({path: '/campaigns/{id}'})).toBe(false)
        // an operation wildcard needs an operationId to exist
        expect(evaluateGovernance([rule({match: {operation: '*'}, action: {type: 'DENY'}})],
            {...req, operationId: undefined}, GOVERNANCE_DECISION.ALLOW).decision).toBe('ALLOW')
    })

    it('a subtree path pattern /campaigns/** targets every endpoint under /campaigns, segment-wise', () => {
        const targets = (path: string, specPath: string) =>
            evaluateGovernance([rule({match: {path}, action: {type: 'DENY'}})], {
                ...req,
                specPath
            }, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        const endpoints = Object.keys(campaignSpec.paths ?? {})
        expect(endpoints).toEqual(['/campaigns', '/campaigns/{id}', '/campaigns/{id}/creatives', '/campaigns/{id}/creative', '/campaigns/{id}/finalize'])
        for (const endpoint of endpoints) {
            expect(targets('/campaigns/**', endpoint)).toBe(true)
            expect(targets('/**', endpoint)).toBe(true)
            expect(targets('/campaigns/{id}/**', endpoint)).toBe(endpoint !== '/campaigns')
            expect(targets('/campaigns', endpoint)).toBe(endpoint === '/campaigns') // a plain path stays exact
        }
        expect(targets('/campaigns/**', '/campaigns-archive')).toBe(false)
        expect(targets('/campaigns/**', '/campaign')).toBe(false)
        expect(targets('/campaigns/**', '/orders/{id}')).toBe(false)
    })

    it('rejects a misplaced ** at load', () => {
        const base = {name: 'ok', action: {type: 'DENY'}}
        for (const path of ['/campaigns/**/finalize', '/campaigns**', '**', '/campaigns/*/**']) {
            const r = governanceRuleSchema.safeParse({...base, match: {path}})
            expect(r.success).toBe(false)
            expect(r.error?.issues[0]?.message).toContain('"**" is only allowed as the whole last segment')
        }
        expect(governanceRuleSchema.safeParse({...base, match: {path: '/campaigns/{id}/**'}}).success).toBe(true)
    })

    it('reads bare fields from the body and explicit body./query./path. prefixes', () => {
        expect(readField(req, 'budget')).toBe(1_500_000)
        expect(readField(req, 'body.owner.team')).toBe('growth')
        expect(readField(req, 'query.dryRun')).toBe(false)
        expect(readField({...req, pathParams: {id: 'C1'}}, 'path.id')).toBe('C1')
        expect(readField(req, 'body.tags.1')).toBe('b')
        expect(readField(req, 'missing.deep')).toBeUndefined()
    })

    it('path parameters compare as they travel, like query values: a numeric rule value matches the URL segment', () => {
        const onCampaign = (id: string): GovernanceRequest => ({
            ...req,
            specPath: '/campaigns/{id}',
            operationId: 'updateCampaign',
            pathParams: {id}
        })
        const denies = (conditions: Record<string, unknown>, id: string) =>
            evaluateGovernance([rule({
                conditions,
                action: {type: 'DENY'}
            })], onCampaign(id), GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        expect(denies({'path.id': {equals: 42}}, '42')).toBe(true) // YAML `equals: 42` is a number; the segment is text
        expect(denies({'path.id': {in: [7, 42]}}, '42')).toBe(true)
        expect(denies({'path.id': {greater_than: 100}}, '150')).toBe(true)
        expect(denies({'path.id': {greater_than: 100}}, '99')).toBe(false)
        expect(denies({'path.id': {greater_than: 100}}, 'C150')).toBe(false) // not a number: no ordering
        expect(denies({'path.id': {equals: 'C1'}}, 'C1')).toBe(true)
        // Body values keep their JSON types.
        expect(evaluateGovernance([rule({conditions: {'body.n': {equals: 42}}, action: {type: 'DENY'}})], {
            ...req,
            body: {n: '42'}
        }, GOVERNANCE_DECISION.ALLOW).decision).toBe('ALLOW')
    })

    it('evaluates every operator; missing fields only satisfy exists:false; type mismatches are false', () => {
        const holds = (conditions: Record<string, unknown>) =>
            evaluateGovernance([rule({
                conditions,
                action: {type: 'DENY'}
            })], req, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        expect(holds({budget: {greater_than: 1_000_000}})).toBe(true)
        expect(holds({budget: {greater_than: 2_000_000}})).toBe(false)
        expect(holds({budget: {greater_than_or_equal: 1_500_000, less_than_or_equal: 1_500_000}})).toBe(true)
        expect(holds({budget: {less_than: 1_500_000}})).toBe(false)
        expect(holds({name: {equals: 'Q4'}})).toBe(true)
        expect(holds({name: {not_equals: 'Q4'}})).toBe(false)
        expect(holds({name: {in: ['Q3', 'Q4']}})).toBe(true)
        expect(holds({name: {not_in: ['Q3', 'Q4']}})).toBe(false)
        expect(holds({name: {starts_with: 'Q'}})).toBe(true)
        expect(holds({name: {contains: '4'}})).toBe(true)
        expect(holds({tags: {contains: 'b'}})).toBe(true)
        expect(holds({tags: {contains: 'z'}})).toBe(false)
        expect(holds({'query.dryRun': {equals: false}})).toBe(true)
        expect(holds({nothing: {exists: false}})).toBe(true)
        expect(holds({nothing: {exists: true}})).toBe(false)
        expect(holds({nothing: {greater_than: 1}})).toBe(false)
        expect(holds({name: {greater_than: 1}})).toBe(false) // string vs number comparison never holds
        expect(holds({budget: {exists: true, greater_than: 1}})).toBe(true)
    })

    it('reads a body passed as a JSON string as the object the backend receives', () => {
        const decide = (body: unknown) => evaluateGovernance(
            [rule({conditions: {budget: {greater_than: 1_000_000}}, action: {type: 'REQUIRE_APPROVAL'}})],
            {...req, body}, GOVERNANCE_DECISION.ALLOW
        ).decision
        expect(decide({budget: 5_000_000})).toBe('REQUIRE_APPROVAL')
        expect(decide(JSON.stringify({budget: 5_000_000}))).toBe('REQUIRE_APPROVAL')
        expect(decide('budget=5000000')).toBe('ALLOW') // not JSON: no body fields to read
        expect(readField({...req, body: '{"owner":{"team":"x"}}'}, 'body.owner.team')).toBe('x')
    })

    it('reads only the request\'s own data — inherited properties are missing fields', () => {
        for (const field of ['constructor', 'body.__proto__', 'body.toString', 'query.hasOwnProperty', 'body.tags.length']) {
            expect(readField(req, field), field).toBe(field === 'body.tags.length' ? 2 : undefined)
        }
        const holds = (conditions: Record<string, unknown>) =>
            evaluateGovernance([rule({
                conditions,
                action: {type: 'DENY'}
            })], req, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        expect(holds({constructor: {exists: true}})).toBe(false)
        expect(holds({constructor: {exists: false}})).toBe(true)
    })

    it('compares query parameters in their wire form: all=true is all=true however the program spelled it', () => {
        const deny = (conditions: Record<string, unknown>, query: Record<string, unknown>) =>
            evaluateGovernance([rule({conditions, action: {type: 'DENY'}})], {
                ...req,
                query
            }, GOVERNANCE_DECISION.ALLOW).decision === 'DENY'
        for (const all of [true, 'true']) expect(deny({'query.all': {equals: true}}, {all}), String(all)).toBe(true)
        expect(deny({'query.all': {equals: 'true'}}, {all: true})).toBe(true)
        expect(deny({'query.limit': {greater_than: 500}}, {limit: '1000'})).toBe(true)
        expect(deny({'query.limit': {greater_than: 500}}, {limit: '100'})).toBe(false)
        expect(deny({'query.limit': {greater_than: 500}}, {limit: '0x3E8'})).toBe(false) // not a wire number
        expect(deny({'query.status': {in: ['draft', 1]}}, {status: '1'})).toBe(true)
        expect(deny({'query.status': {not_in: [1]}}, {status: '1'})).toBe(false)
        expect(deny({'query.page': {starts_with: '1'}}, {page: 12})).toBe(true)
        // Outside the query types stay strict.
        expect(deny({'body.all': {equals: true}}, {})).toBe(false)
        expect(evaluateGovernance([rule({conditions: {'body.all': {equals: true}}, action: {type: 'DENY'}})], {
            ...req,
            body: {all: 'true'}
        }, GOVERNANCE_DECISION.ALLOW).decision).toBe('ALLOW')
    })

    it('refuses a path that is not a template, a subtree or *: it could never match and would govern nothing', () => {
        const base = {name: 'ok', action: {type: 'DENY'}}
        expect(governanceRuleSchema.safeParse({...base, match: {path: 'campaigns/{id}'}}).success).toBe(false)
        for (const path of ['*', '/campaigns/{id}', '/campaigns/**', '/**']) expect(governanceRuleSchema.safeParse({
            ...base,
            match: {path}
        }).success, path).toBe(true)
    })

    describe('condition tree and computed operands', () => {
        const campaign = (body: Record<string, unknown>, query: Record<string, unknown> = {}): GovernanceRequest =>
            ({...req, body, query})
        const decide = (conditions: unknown, request: GovernanceRequest) =>
            evaluateGovernance([rule({
                conditions,
                action: {type: 'REQUIRE_APPROVAL'}
            })], request, GOVERNANCE_DECISION.ALLOW).decision

        it('"budget > 20% of total budget" — percent_of', () => {
            const c = {percent_of: {part: 'body.budget', whole: 'body.totalBudget'}, greater_than: 20}
            expect(decide(c, campaign({budget: 25_000, totalBudget: 100_000}))).toBe('REQUIRE_APPROVAL')
            expect(decide(c, campaign({budget: 20_000, totalBudget: 100_000}))).toBe('ALLOW') // exactly 20% is not > 20%
            expect(decide(c, campaign({budget: 21, totalBudget: 100}))).toBe('REQUIRE_APPROVAL')
        })

        it('"bid > 1.3x current bid" — ratio', () => {
            const c = {ratio: {numerator: 'body.bid', denominator: 'body.currentBid'}, greater_than: 1.3}
            expect(decide(c, campaign({bid: 131, currentBid: 100}))).toBe('REQUIRE_APPROVAL')
            expect(decide(c, campaign({bid: 130, currentBid: 100}))).toBe('ALLOW') // exactly 1.3x
            // computed values are rounded, so float noise never flips a boundary: 1.43 / 1.1 is 1.3, 100 × 1.1 is 110
            expect(decide({
                ratio: {numerator: 'body.bid', denominator: 'body.currentBid'},
                equals: 1.3
            }, campaign({bid: 1.43, currentBid: 1.1}))).toBe('REQUIRE_APPROVAL')
            expect(decide({
                percent_of: {part: 'body.budget', whole: 'body.totalBudget'},
                greater_than: 110
            }, campaign({budget: 1.1, totalBudget: 1}))).toBe('ALLOW')
        })

        it('"endDate is 30 days after startDate" — days_between with ISO dates and zoned date-times', () => {
            const c = {days_between: {from: 'body.startDate', to: 'body.endDate'}, equals: 30}
            expect(decide(c, campaign({startDate: '2026-03-01', endDate: '2026-03-31'}))).toBe('REQUIRE_APPROVAL')
            expect(decide(c, campaign({startDate: '2026-03-01', endDate: '2026-03-30'}))).toBe('ALLOW')
            expect(decide(c, campaign({
                startDate: '2026-03-01T00:00:00Z',
                endDate: '2026-03-31T05:30:00+05:30'
            }))).toBe('REQUIRE_APPROVAL')
            expect(decide({days_between: {from: 'body.startDate', to: 'body.endDate'}, less_than: 0},
                campaign({startDate: '2026-03-31', endDate: '2026-03-01'}))).toBe('REQUIRE_APPROVAL') // end before start is negative
        })

        it('a computed operand that cannot be computed is treated like a missing field', () => {
            const ratio = {ratio: {numerator: 'body.bid', denominator: 'body.currentBid'}, greater_than: 0}
            const days = {days_between: {from: 'body.startDate', to: 'body.endDate'}, greater_than: -1_000_000}
            for (const [c, body] of [
                [ratio, {bid: 5, currentBid: 0}],                      // division by zero
                [ratio, {bid: '5', currentBid: 1}],                    // not a number
                [ratio, {currentBid: 1}],                              // missing
                [days, {startDate: '2026-02-30', endDate: '2026-03-31'}],            // not a calendar date (JS would roll it to March 2)
                [days, {startDate: '2026-03-01T10:00:00', endDate: '2026-03-31'}],   // date-time without a zone: host-dependent, refused
                [days, {startDate: '01/03/2026', endDate: '2026-03-31'}]             // not ISO 8601
            ] as const) {
                expect(decide(c, campaign(body))).toBe('ALLOW')
            }
            expect(decide({
                ratio: {numerator: 'body.bid', denominator: 'body.currentBid'},
                exists: false
            }, campaign({bid: 5, currentBid: 0}))).toBe('REQUIRE_APPROVAL')
        })

        it('allOf = AND, anyOf = OR, not = NOT, nested', () => {
            const c = {
                allOf: [
                    {field: 'body.channel', in: ['tv', 'radio']},
                    {anyOf: [{field: 'body.priority', equals: 'high'}, {not: {field: 'query.dryRun', equals: true}}]}
                ]
            }
            expect(decide(c, campaign({channel: 'tv', priority: 'low'}, {dryRun: false}))).toBe('REQUIRE_APPROVAL')
            expect(decide(c, campaign({channel: 'tv', priority: 'high'}, {dryRun: true}))).toBe('REQUIRE_APPROVAL')
            expect(decide(c, campaign({channel: 'tv', priority: 'low'}, {dryRun: true}))).toBe('ALLOW')   // anyOf fails
            expect(decide(c, campaign({channel: 'web', priority: 'high'}, {dryRun: false}))).toBe('ALLOW') // allOf fails
            expect(decide({not: {field: 'body.missing', exists: true}}, campaign({}))).toBe('REQUIRE_APPROVAL')
        })

        it('the flat form decides exactly like its allOf tree', () => {
            const flat = {budget: {greater_than: 1000}, 'query.dryRun': {not_equals: true}, name: {starts_with: 'Q'}}
            const tree = {
                allOf: [
                    {field: 'budget', greater_than: 1000},
                    {field: 'query.dryRun', not_equals: true},
                    {field: 'name', starts_with: 'Q'}
                ]
            }
            for (const [body, query] of [
                [{budget: 5000, name: 'Q4'}, {dryRun: false}],
                [{budget: 5000, name: 'Q4'}, {dryRun: true}],
                [{budget: 10, name: 'Q4'}, {}],
                [{budget: 5000, name: 'H1'}, {}],
                [{name: 'Q4'}, {}]
            ] as const) {
                expect(decide(flat, campaign(body, query))).toBe(decide(tree, campaign(body, query)))
            }
        })
    })

    it('applies DENY > REQUIRE_APPROVAL > ALLOW among conflicting matches and names the deciding rule', () => {
        const rules = [
            rule({name: 'allow-all', action: {type: 'ALLOW'}}, 'a.yaml'),
            rule({
                name: 'needs-approval',
                version: 7,
                conditions: {budget: {greater_than: 1}},
                action: {type: 'REQUIRE_APPROVAL', reason: 'big spend'}
            }, 'b.yaml'),
            rule({name: 'not-matching', match: {service: 'zzz'}, action: {type: 'DENY'}}, 'c.yaml')
        ]
        const out = evaluateGovernance(rules, req, GOVERNANCE_DECISION.ALLOW)
        expect(out).toEqual({
            decision: 'REQUIRE_APPROVAL', reason: 'big spend', decidingRule: 'needs-approval',
            matchedRules: ['allow-all', 'needs-approval'],
            ruleVersions: ['allow-all@1#abcdef012345', 'needs-approval@7#abcdef012345']
        })
        const withDeny = [...rules, rule({name: 'hard-stop', action: {type: 'DENY'}}, 'd.yaml')]
        const denied = evaluateGovernance(withDeny, req, GOVERNANCE_DECISION.ALLOW)
        expect(denied.decision).toBe('DENY')
        expect(denied.decidingRule).toBe('hard-stop')
        expect(denied.reason).toBe(`${GOVERNANCE_REASON.RULE_MATCHED}: hard-stop`)
        // two rules with the same winning action: the first in file order decides
        const twoDeny = [rule({name: 'd-later', action: {type: 'DENY'}}, 'z.yaml'), rule({
            name: 'd-first',
            action: {type: 'DENY'}
        }, 'a.yaml')]
        expect(evaluateGovernance(twoDeny, req, GOVERNANCE_DECISION.ALLOW).decidingRule).toBe('d-later')
    })

    describe('three rule levels: gateway < service < endpoint; final pins a broader level', () => {
        const G_NO_DELETES = {
            name: 'no-deletes',
            match: {method: 'DELETE'},
            action: {type: 'DENY', reason: 'no deletes'}
        }
        const S_TRAFFICKING = {name: 'trafficking-ok', match: {service: 'trafficking'}, action: {type: 'ALLOW'}}
        const E_BIG_BUDGET = {
            name: 'big-budget', match: {service: 'trafficking', operation: 'createCampaign'},
            conditions: {budget: {greater_than: 1_000_000}}, action: {type: 'REQUIRE_APPROVAL', reason: 'big'}
        }
        const create = (budget: number): GovernanceRequest => ({...req, body: {budget}})
        const del: GovernanceRequest = {
            ...req,
            method: 'DELETE',
            specPath: '/campaigns/{id}',
            operationId: 'deleteCampaign',
            body: undefined
        }
        const onBilling = (r: GovernanceRequest): GovernanceRequest => ({...r, service: 'billing'})
        const outcome = (rules: Array<Record<string, unknown>>, request: GovernanceRequest) =>
            evaluateGovernance(rules.map((r, i) => rule(r, `${i}.yaml`)), request, GOVERNANCE_DECISION.ALLOW)

        it('derives the level from match; wildcards and method lists do not raise it', () => {
            const level = (match: Record<string, unknown>) => ruleLevel(governanceRuleSchema.parse({
                name: 'x',
                match,
                action: {type: 'ALLOW'}
            }))
            expect(level({method: 'DELETE'})).toBe(RULE_LEVEL.GATEWAY)
            expect(level({method: ['GET', 'PUT']})).toBe(RULE_LEVEL.GATEWAY)
            expect(level({service: '*', operation: '*', path: '/**'})).toBe(RULE_LEVEL.GATEWAY)
            expect(level({service: 'trafficking'})).toBe(RULE_LEVEL.SERVICE)
            expect(level({service: 'trafficking', method: 'POST', path: '*'})).toBe(RULE_LEVEL.SERVICE)
            expect(level({service: 'trafficking', operation: 'createCampaign'})).toBe(RULE_LEVEL.ENDPOINT)
            expect(level({path: '/campaigns/**'})).toBe(RULE_LEVEL.ENDPOINT)
            expect(level({operation: 'createCampaign'})).toBe(RULE_LEVEL.ENDPOINT)
        })

        it('the most specific matching level decides', () => {
            const rules = [G_NO_DELETES, S_TRAFFICKING, E_BIG_BUDGET]
            expect(outcome(rules, create(2_000_000))).toMatchObject({
                decision: 'REQUIRE_APPROVAL',
                decidingRule: 'big-budget',
                matchedRules: ['trafficking-ok', 'big-budget']
            })
            // the endpoint rule's condition is false ⇒ the service level decides
            expect(outcome(rules, create(500))).toMatchObject({decision: 'ALLOW', decidingRule: 'trafficking-ok'})
            // service overrides gateway: the gateway DENY is not final
            expect(outcome(rules, del)).toMatchObject({
                decision: 'ALLOW',
                decidingRule: 'trafficking-ok',
                matchedRules: ['no-deletes', 'trafficking-ok']
            })
            // no service rule for billing ⇒ the gateway decides
            expect(outcome(rules, onBilling(del))).toMatchObject({decision: 'DENY', decidingRule: 'no-deletes'})
            // each level alone
            expect(outcome([E_BIG_BUDGET], create(2_000_000)).decision).toBe('REQUIRE_APPROVAL')
            expect(outcome([S_TRAFFICKING], del).decision).toBe('ALLOW')
            expect(outcome([G_NO_DELETES], del).decision).toBe('DENY')
        })

        it('final pins the decision to its level — a gateway guardrail no service or endpoint rule can override', () => {
            const guardrail = {...G_NO_DELETES, final: true}
            const endpointAllow = {
                name: 'delete-ok',
                match: {service: 'trafficking', path: '/campaigns/{id}'},
                action: {type: 'ALLOW'}
            }
            expect(outcome([guardrail, S_TRAFFICKING, endpointAllow], del)).toMatchObject({
                decision: 'DENY',
                decidingRule: 'no-deletes'
            })
            // final only matters when it matches: a POST is decided as before
            expect(outcome([guardrail, S_TRAFFICKING, E_BIG_BUDGET], create(2_000_000)).decision).toBe('REQUIRE_APPROVAL')
            // a final service rule beats an endpoint rule
            const serviceFreeze = {
                name: 'billing-frozen',
                match: {service: 'billing'},
                final: true,
                action: {type: 'DENY', reason: 'frozen'}
            }
            const billingEndpointOk = {
                name: 'billing-create-ok',
                match: {service: 'billing', operation: 'createCampaign'},
                action: {type: 'ALLOW'}
            }
            expect(outcome([serviceFreeze, billingEndpointOk], onBilling(create(1))).decidingRule).toBe('billing-frozen')
            // two finals ⇒ the broadest one's level decides
            const finalServiceAllow = {...S_TRAFFICKING, final: true}
            expect(outcome([guardrail, finalServiceAllow], del).decidingRule).toBe('no-deletes')
        })

        it('final pins the level, not the action: within that level the strongest action still wins', () => {
            const finalAllow = {name: 'gateway-ok', match: {service: '*'}, final: true, action: {type: 'ALLOW'}}
            const gatewayDeny = {name: 'no-deletes', match: {method: 'DELETE'}, action: {type: 'DENY'}}
            const endpointAllow = {name: 'delete-ok', match: {path: '/campaigns/{id}'}, action: {type: 'ALLOW'}}
            expect(outcome([finalAllow, gatewayDeny, endpointAllow], del)).toMatchObject({
                decision: 'DENY',
                decidingRule: 'no-deletes'
            })
        })

        it('same-level conflicts keep DENY > REQUIRE_APPROVAL > ALLOW', () => {
            const approve = {
                name: 'service-approve',
                match: {service: 'trafficking', method: 'POST'},
                action: {type: 'REQUIRE_APPROVAL'}
            }
            expect(outcome([S_TRAFFICKING, approve], create(1))).toMatchObject({
                decision: 'REQUIRE_APPROVAL',
                decidingRule: 'service-approve'
            })
        })

        it('method lists restrict a rule to those kinds of request, at any level', () => {
            const reads = {name: 'reads-ok', match: {service: 'trafficking', method: ['GET']}, action: {type: 'ALLOW'}}
            const writes = {
                name: 'writes-need-approval',
                match: {service: 'trafficking', method: ['POST', 'PUT', 'PATCH']},
                action: {type: 'REQUIRE_APPROVAL'}
            }
            const get: GovernanceRequest = {...req, method: 'GET'}
            const put: GovernanceRequest = {...req, method: 'PUT'}
            expect(outcome([reads, writes], get)).toMatchObject({decision: 'ALLOW', decidingRule: 'reads-ok'})
            expect(outcome([reads, writes], put)).toMatchObject({
                decision: 'REQUIRE_APPROVAL',
                decidingRule: 'writes-need-approval'
            })
            expect(outcome([reads, writes], del).matchedRules).toEqual([])
            expect(governanceRuleSchema.safeParse({
                name: 'x',
                match: {method: []},
                action: {type: 'ALLOW'}
            }).success).toBe(false)
            expect(governanceRuleSchema.safeParse({
                name: 'x',
                match: {method: ['GET', 'FETCH']},
                action: {type: 'ALLOW'}
            }).success).toBe(false)
        })
    })

    describe('explicit gateway/service rule scopes', () => {
        const deleting = (service: string): GovernanceRequest => ({
            ...req,
            service,
            method: 'DELETE',
            specPath: '/records/{id}',
            operationId: 'deleteRecord',
            body: undefined
        })

        it('applies a gateway final DENY across services and qualifies persisted rule identities', () => {
            const gatewayDeny = rule({
                name: 'no-deletes',
                match: {method: 'DELETE'},
                final: true,
                action: {type: 'DENY'}
            })
            for (const service of ['orders', 'payments']) {
                const serviceRules = [
                    rule({
                        name: 'no-deletes',
                        match: {service, method: 'DELETE'},
                        final: true,
                        action: {type: 'ALLOW'}
                    }),
                    rule({
                        name: 'delete-endpoint-allowed',
                        match: {service, operation: 'deleteRecord'},
                        action: {type: 'ALLOW'}
                    })
                ]
                expect(evaluateGovernance({
                    gatewayRules: [gatewayDeny],
                    serviceRules
                }, deleting(service), GOVERNANCE_DECISION.ALLOW)).toMatchObject({
                    decision: GOVERNANCE_DECISION.DENY,
                    decidingRule: 'gateway/no-deletes',
                    matchedRules: [
                        'gateway/no-deletes',
                        `${service}/no-deletes`,
                        `${service}/delete-endpoint-allowed`
                    ],
                    ruleVersions: [
                        'gateway/no-deletes@1#abcdef012345',
                        `${service}/no-deletes@1#abcdef012345`,
                        `${service}/delete-endpoint-allowed@1#abcdef012345`
                    ]
                })
            }
        })

        it('keeps service-owned broad rules at service scope and ordinary precedence specific', () => {
            const request = deleting('orders')
            const gatewayAllow = rule({
                name: 'gateway-allow',
                match: {method: 'DELETE'},
                action: {type: 'ALLOW'}
            })
            const serviceFinal = rule({
                name: 'service-final-allow',
                match: {method: 'DELETE'},
                final: true,
                action: {type: 'ALLOW'}
            })
            const endpointDeny = rule({
                name: 'endpoint-deny',
                match: {operation: 'deleteRecord'},
                action: {type: 'DENY'}
            })
            expect(evaluateGovernance({
                gatewayRules: [gatewayAllow],
                serviceRules: [serviceFinal, endpointDeny]
            }, request, GOVERNANCE_DECISION.ALLOW)).toMatchObject({
                decision: GOVERNANCE_DECISION.ALLOW,
                decidingRule: 'orders/service-final-allow'
            })

            expect(evaluateGovernance({
                gatewayRules: [gatewayAllow],
                serviceRules: [rule({
                    name: 'service-allow',
                    match: {service: 'orders'},
                    action: {type: 'ALLOW'}
                }), endpointDeny]
            }, request, GOVERNANCE_DECISION.ALLOW)).toMatchObject({
                decision: GOVERNANCE_DECISION.DENY,
                decidingRule: 'orders/endpoint-deny'
            })
        })

        it.each([
            {
                label: 'endpoint final DENY beats broader non-final REQUIRE_APPROVAL',
                gatewayRules: [],
                serviceRules: [
                    rule({
                        name: 'service-approve',
                        match: {method: 'DELETE'},
                        action: {type: 'REQUIRE_APPROVAL'}
                    }),
                    rule({
                        name: 'endpoint-deny',
                        match: {operation: 'deleteRecord'},
                        final: true,
                        action: {type: 'DENY'}
                    })
                ],
                expected: {decision: GOVERNANCE_DECISION.DENY, decidingRule: 'orders/endpoint-deny'}
            },
            {
                label: 'endpoint final REQUIRE_APPROVAL beats broader non-final DENY',
                gatewayRules: [],
                serviceRules: [
                    rule({
                        name: 'service-deny',
                        match: {method: 'DELETE'},
                        action: {type: 'DENY'}
                    }),
                    rule({
                        name: 'endpoint-approve',
                        match: {operation: 'deleteRecord'},
                        final: true,
                        action: {type: 'REQUIRE_APPROVAL'}
                    })
                ],
                expected: {decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, decidingRule: 'orders/endpoint-approve'}
            },
            {
                label: 'service final REQUIRE_APPROVAL beats endpoint final DENY because the broadest final tier wins',
                gatewayRules: [],
                serviceRules: [
                    rule({
                        name: 'service-approve',
                        match: {method: 'DELETE'},
                        final: true,
                        action: {type: 'REQUIRE_APPROVAL'}
                    }),
                    rule({
                        name: 'endpoint-deny',
                        match: {operation: 'deleteRecord'},
                        final: true,
                        action: {type: 'DENY'}
                    })
                ],
                expected: {decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, decidingRule: 'orders/service-approve'}
            },
            {
                label: 'gateway final ALLOW beats service final DENY and endpoint final REQUIRE_APPROVAL',
                gatewayRules: [rule({
                    name: 'gateway-allow',
                    match: {method: 'DELETE'},
                    final: true,
                    action: {type: 'ALLOW'}
                })],
                serviceRules: [
                    rule({
                        name: 'service-deny',
                        match: {method: 'DELETE'},
                        final: true,
                        action: {type: 'DENY'}
                    }),
                    rule({
                        name: 'endpoint-approve',
                        match: {operation: 'deleteRecord'},
                        final: true,
                        action: {type: 'REQUIRE_APPROVAL'}
                    })
                ],
                expected: {decision: GOVERNANCE_DECISION.ALLOW, decidingRule: 'gateway/gateway-allow'}
            },
            {
                label: 'gateway final REQUIRE_APPROVAL beats service final DENY and endpoint final ALLOW',
                gatewayRules: [rule({
                    name: 'gateway-approve',
                    match: {method: 'DELETE'},
                    final: true,
                    action: {type: 'REQUIRE_APPROVAL'}
                })],
                serviceRules: [
                    rule({
                        name: 'service-deny',
                        match: {method: 'DELETE'},
                        final: true,
                        action: {type: 'DENY'}
                    }),
                    rule({
                        name: 'endpoint-allow',
                        match: {operation: 'deleteRecord'},
                        final: true,
                        action: {type: 'ALLOW'}
                    })
                ],
                expected: {decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, decidingRule: 'gateway/gateway-approve'}
            }
        ])('$label', ({gatewayRules, serviceRules, expected}) => {
            expect(evaluateGovernance({
                gatewayRules,
                serviceRules
            }, deleting('orders'), GOVERNANCE_DECISION.ALLOW)).toMatchObject(expected)
        })
    })

    it('fails closed to DENY when evaluation itself throws', () => {
        const poison = {
            rule: Object.defineProperty({...rule({}).rule}, 'match', {
                get() {
                    throw new Error('boom')
                }
            }), source: 'x', contentHash: 'h'
        } as LoadedRule
        const out = evaluateGovernance([poison], req, GOVERNANCE_DECISION.ALLOW)
        expect(out.decision).toBe('DENY')
        expect(out.reason).toContain(GOVERNANCE_REASON.EVALUATION_FAILED)
    })
})

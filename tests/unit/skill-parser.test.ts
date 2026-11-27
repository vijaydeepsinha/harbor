// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {parseSkillFile} from '../../src/runtime/registry/skill-parser.js'

describe('parseSkillFile', () => {
    it('parses standard Agent Skills frontmatter and returns body-only content', () => {
        const raw = `---
name: manage-campaigns
description: Create and manage campaigns. Use for campaign workflows.
license: Apache-2.0
compatibility: Requires access to the Campaigns API.
metadata:
  tags: "campaigns, marketing"
  owner: growth
allowed-tools: Read
---

# Manage Campaigns

Step one.
`

        expect(parseSkillFile('manage-campaigns.md', raw)).toEqual({
            name: 'manage-campaigns',
            filename: 'manage-campaigns.md',
            description: 'Create and manage campaigns. Use for campaign workflows.',
            content: '# Manage Campaigns\n\nStep one.\n',
            license: 'Apache-2.0',
            compatibility: 'Requires access to the Campaigns API.',
            metadata: {
                tags: 'campaigns, marketing',
                owner: 'growth'
            },
            'allowed-tools': 'Read'
        })
    })

    it.each([
        [
            'missing name',
            '---\ndescription: Manage tasks.\n---\nBody',
            '"name" must be 1-64 lowercase'
        ],
        [
            'missing description',
            '---\nname: manage-tasks\n---\nBody',
            '"description" must contain 1-1024 characters'
        ],
        [
            'filename mismatch',
            '---\nname: another-name\ndescription: Manage tasks.\n---\nBody',
            '"name" must match the filename stem "manage-tasks"'
        ],
        [
            'legacy fields',
            '---\nid: manage-tasks\ntitle: Manage tasks\ntags: [task]\ndescription: Manage tasks.\n---\nBody',
            'unsupported top-level field(s): id, title, tags'
        ],
        [
            'non-string metadata',
            '---\nname: manage-tasks\ndescription: Manage tasks.\nmetadata:\n  tags: [task]\n---\nBody',
            '"metadata.tags" must be a string'
        ]
    ])('rejects %s', (_case, raw, message) => {
        expect(() => parseSkillFile('manage-tasks.md', raw)).toThrow(message)
    })
})

describe('demo order skill', () => {
    it('describes business workflow without duplicating governance policy', () => {
        const parsed = parseSkillFile(
            'place-order.md',
            readFileSync('services/order/skills/place-order.md', 'utf8')
        )

        expect(parsed.description).toContain('calculates the order total')
        expect(parsed.content).toContain('GET /products/{id}')
        expect(parsed.content).toContain('amountInr = price × quantity')
        expect(parsed.content).toContain('POST /orders')
        expect(parsed.content).not.toMatch(/5,?000|approval|REQUIRE_APPROVAL|GOVERNANCE_DENIED|requestState/i)
    })
})

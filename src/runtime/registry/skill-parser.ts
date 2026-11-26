// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import matter from 'gray-matter'
import {basename} from 'node:path'

export interface SkillMetadata {
    name: string
    filename: string
    description: string
    content: string
    license?: string
    compatibility?: string
    metadata?: Record<string, string>
    'allowed-tools'?: string
}

const ALLOWED_FRONTMATTER_FIELDS = new Set([
    'name',
    'description',
    'license',
    'compatibility',
    'metadata',
    'allowed-tools'
])

function parseError(filename: string, message: string): never {
    throw new Error(`Invalid Agent Skills frontmatter in "${filename}": ${message}`)
}

function optionalString(
    data: Record<string, unknown>,
    field: string,
    filename: string
): string | undefined {
    const value = data[field]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim().length === 0) {
        parseError(filename, `"${field}" must be a non-empty string`)
    }
    return value.trim()
}

function parseMetadata(raw: unknown, filename: string): Record<string, string> | undefined {
    if (raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        parseError(filename, '"metadata" must be a mapping')
    }

    const metadata: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string') {
            parseError(filename, `"metadata.${key}" must be a string`)
        }
        metadata[key] = value
    }
    return metadata
}

export function parseSkillFile(filename: string, raw: string): SkillMetadata {
    const {data, content} = matter(raw)
    const unsupported = Object.keys(data).filter(field => !ALLOWED_FRONTMATTER_FIELDS.has(field))
    if (unsupported.length > 0) {
        parseError(filename, `unsupported top-level field(s): ${unsupported.join(', ')}`)
    }

    const name = typeof data['name'] === 'string' ? data['name'].trim() : ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        parseError(
            filename,
            '"name" must be 1-64 lowercase alphanumeric/hyphen characters without leading, trailing, or consecutive hyphens'
        )
    }
    if (name !== basename(filename, '.md')) {
        parseError(filename, `"name" must match the filename stem "${basename(filename, '.md')}"`)
    }

    const description = optionalString(data, 'description', filename)
    if (!description || description.length > 1024) {
        parseError(filename, '"description" must contain 1-1024 characters')
    }

    const compatibility = optionalString(data, 'compatibility', filename)
    if (compatibility && compatibility.length > 500) {
        parseError(filename, '"compatibility" must contain at most 500 characters')
    }

    const license = optionalString(data, 'license', filename)
    const allowedTools = optionalString(data, 'allowed-tools', filename)
    const metadata = parseMetadata(data['metadata'], filename)

    return {
        name,
        filename,
        description,
        content: content.trimStart(),
        ...(license !== undefined ? {license} : {}),
        ...(compatibility !== undefined ? {compatibility} : {}),
        ...(metadata !== undefined ? {metadata} : {}),
        ...(allowedTools !== undefined ? {'allowed-tools': allowedTools} : {})
    }
}

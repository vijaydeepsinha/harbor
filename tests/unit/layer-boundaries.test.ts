// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {readdirSync, readFileSync} from 'node:fs'
import {posix} from 'node:path'
import ts from 'typescript'
import {describe, expect, it} from 'vitest'

const PROVIDER_CONTRACTS = new Set([
    'AuthStrategy', 'TokenCacheStrategy', 'IdempotencyStrategy',
    'PermissionGuard', 'CircuitBreakerStrategy', 'SpecLoaderStrategy',
    'ConnectorAPI', 'ExecutionPersistence', 'GovernanceRuleSource', 'AuditSink'
])

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const path = posix.join(dir, entry.name)
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
    })
}

function parse(path: string): ts.SourceFile {
    return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
}

function dependency(path: string, specifier: string): string | undefined {
    return specifier.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, '.ts')
        : undefined
}

describe('source layer boundaries', () => {
    it('keeps every SPI module declarative, without implementation or compatibility exports', () => {
        for (const path of sourceFiles('src/spi')) {
            const source = parse(path)
            for (const statement of source.statements) {
                expect(
                    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
                    (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
                    (ts.isExportDeclaration(statement) && statement.isTypeOnly),
                    `${path}: SPI must contain contracts, not executable implementations`
                ).toBe(true)
            }
        }
    })

    it('prevents outward dependencies from core/adapters/contracts and direct runtime adapter selection', () => {
        const violations: string[] = []
        for (const path of sourceFiles('src')) {
            const check = (specifier: string) => {
                const target = dependency(path, specifier)
                if (!target?.startsWith('src/')) return
                const layer = target.split('/')[1]
                if (path.startsWith('src/core/') && layer !== 'core') violations.push(`${path} depends on ${target}`)
                if (path.startsWith('src/spi/') && layer !== 'core' && layer !== 'spi') violations.push(`${path} depends on ${target}`)
                if ((path.startsWith('src/runtime/') || path.startsWith('src/tools/')) && layer === 'adapters') {
                    violations.push(`${path} selects concrete adapter ${target}; use wiring`)
                }
                if (path.startsWith('src/adapters/') && !['core', 'spi', 'adapters'].includes(layer ?? '')) {
                    violations.push(`${path} depends on ${target}`)
                }
            }
            const visit = (node: ts.Node): void => {
                if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    check(node.moduleSpecifier.text)
                }
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const specifier = node.arguments[0]
                    if (specifier && ts.isStringLiteral(specifier)) check(specifier.text)
                }
                ts.forEachChild(node, visit)
            }
            visit(parse(path))
        }
        expect(violations).toEqual([])
    })

    it('declares each provider interface exactly once, in SPI rather than core', () => {
        const declarations = new Map<string, string[]>()
        for (const path of sourceFiles('src')) {
            for (const statement of parse(path).statements) {
                if (!ts.isInterfaceDeclaration(statement) || !PROVIDER_CONTRACTS.has(statement.name.text)) continue
                const name = statement.name.text
                declarations.set(name, [...(declarations.get(name) ?? []), path])
            }
        }
        for (const name of PROVIDER_CONTRACTS) {
            const paths = declarations.get(name) ?? []
            expect(paths, name).toHaveLength(1)
            expect(paths[0], name).toMatch(/^src\/spi\//)
        }
    })
})

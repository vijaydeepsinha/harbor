// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Builds artifacts/governance-test-summary.json from the vitest JSON report
 * (artifacts/e2e/results.json) and the Postman runner report
 * (artifacts/postman/results.json). Missing inputs are reported as absent,
 * never silently counted as passed.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function buildSummary(artifactsRoot) {
    const e2ePath = join(artifactsRoot, 'e2e', 'results.json')
    const postmanPath = join(artifactsRoot, 'postman', 'results.json')
    const summary = {
        generatedAt: new Date().toISOString(),
        e2e: null,
        postman: null,
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        status: 'unknown'
    }

    if (existsSync(e2ePath)) {
        const r = JSON.parse(readFileSync(e2ePath, 'utf8'))
        const files = (r.testResults ?? []).map(f => ({
            file: f.name?.replace(/^.*tests\/e2e\//, 'tests/e2e/') ?? f.name,
            status: f.status,
            tests: (f.assertionResults ?? []).map(t => ({
                name: t.fullName ?? t.title,
                status: t.status,
                durationMs: t.duration ?? null
            }))
        }))
        summary.e2e = {
            total: r.numTotalTests ?? 0, passed: r.numPassedTests ?? 0, failed: r.numFailedTests ?? 0,
            skipped: (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0), success: r.success === true, files
        }
    }
    if (existsSync(postmanPath)) {
        const r = JSON.parse(readFileSync(postmanPath, 'utf8'))
        const s = r.run?.stats?.assertions ?? r.stats?.assertions ?? {total: 0, failed: 0, pending: 0}
        summary.postman = {
            total: s.total ?? 0,
            failed: s.failed ?? 0,
            passed: (s.total ?? 0) - (s.failed ?? 0) - (s.pending ?? 0),
            skipped: s.pending ?? 0,
            requests: r.run?.stats?.requests ?? r.stats?.requests ?? null
        }
    }
    for (const part of [summary.e2e, summary.postman]) {
        if (!part) continue
        summary.total += part.total;
        summary.passed += part.passed;
        summary.failed += part.failed;
        summary.skipped += part.skipped
    }
    summary.status = !summary.e2e && !summary.postman ? 'no-results' : summary.failed > 0 ? 'failed' : 'passed'
    mkdirSync(artifactsRoot, {recursive: true})
    writeFileSync(join(artifactsRoot, 'governance-test-summary.json'), JSON.stringify(summary, null, 2))
    return summary
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const s = buildSummary(process.argv[2] ?? 'artifacts')
    console.log(JSON.stringify({
        status: s.status,
        total: s.total,
        passed: s.passed,
        failed: s.failed,
        skipped: s.skipped
    }, null, 2))
}

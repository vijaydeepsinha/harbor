// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Readiness polling shared by the orchestrator, the local stack and CI.
 *   node tests/e2e/setup/wait-for.mjs http://127.0.0.1:3333/health http://127.0.0.1:4010/health [--timeout 90000]
 */
export async function waitForUrl(url, {timeoutMs = 90_000, intervalMs = 500, expectJsonField} = {}) {
    const started = Date.now()
    let last = 'no response yet'
    for (; ;) {
        try {
            const res = await fetch(url, {signal: AbortSignal.timeout(2000)})
            if (res.ok) {
                if (!expectJsonField) return true
                const body = await res.json()
                if (body?.[expectJsonField.key] === expectJsonField.value) return true
                last = `${url} answered but ${expectJsonField.key}=${JSON.stringify(body?.[expectJsonField.key])}`
            } else {
                last = `${url} → HTTP ${res.status}`
            }
        } catch (err) {
            last = `${url} → ${err?.cause?.code ?? err?.name ?? err}`
        }
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${url} (${last})`)
        await new Promise(r => setTimeout(r, intervalMs))
    }
}

export async function waitForAll(urls, opts) {
    await Promise.all(urls.map(u => waitForUrl(u, opts)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2)
    const t = args.indexOf('--timeout')
    const timeoutMs = t >= 0 ? Number(args[t + 1]) : 90_000
    const urls = args.filter((a, i) => !a.startsWith('--') && (t < 0 || i !== t + 1))
    waitForAll(urls, {timeoutMs})
        .then(() => {
            console.log(`ready: ${urls.join(', ')}`)
        })
        .catch(err => {
            console.error(err.message);
            process.exit(1)
        })
}

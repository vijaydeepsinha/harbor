// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * The one spelling of a program-supplied `api.request` path that governance
 * resolves, the journal records and the connector sends.
 *
 * Why this exists: governance used to judge the raw string while axios, the
 * WHATWG URL parser and the backend normalised it on the way out — so
 * `/orders/./1`, `/x/../orders/1`, `/%6frders/1` or an absolute URL reached
 * an operation a rule denies while the resolver saw "no such operation".
 * Canonicalising once, before resolution, closes that gap: whatever the
 * rules evaluated is byte-for-byte what goes on the wire.
 *
 * Refused outright (the program gets INVALID_API_REQUEST, nothing is sent):
 * absolute or protocol-relative URLs, backslashes, fragments, empty interior
 * segments, `.`/`..` segments (literal or percent-encoded), segments whose
 * decoding yields `/`, `\` or a control character, malformed percent-encoding,
 * and a query string that repeats a key or collides with `params`.
 */
export type CanonicalRequestPath =
    | { ok: true; path: string; params?: Record<string, unknown> }
    | { ok: false; detail: string }

const SCHEME_URL = /^[a-z][a-z\d+\-.]*:\/\//i
const CONTROL = /[\u0000-\u001f\u007f]/

export function canonicalizeRequestPath(
    rawPath: string,
    params: Record<string, unknown> | undefined
): CanonicalRequestPath {
    if (SCHEME_URL.test(rawPath) || rawPath.startsWith('//')) {
        return refuse('arg.path must be a path on the service (e.g. /orders/1), not a URL')
    }
    if (rawPath.includes('\\')) return refuse('arg.path must not contain a backslash')
    if (rawPath.includes('#')) return refuse('arg.path must not contain a fragment (#)')
    if (CONTROL.test(rawPath)) return refuse('arg.path must not contain control characters')

    const q = rawPath.indexOf('?')
    const pathPart = q === -1 ? rawPath : rawPath.slice(0, q)
    const queryPart = q === -1 ? undefined : rawPath.slice(q + 1)

    // A missing leading slash was always accepted (axios joins it onto the base URL); keep that.
    const segments = (pathPart.startsWith('/') ? pathPart.slice(1) : pathPart).split('/')
    const canonical: string[] = []
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i] as string
        if (seg === '') {
            // Only a trailing slash (or the bare root) may leave an empty segment.
            if (i === segments.length - 1) {
                canonical.push('');
                continue
            }
            return refuse('arg.path must not contain empty segments (//)')
        }
        let decoded: string
        try {
            decoded = decodeURIComponent(seg)
        } catch {
            return refuse(`arg.path has malformed percent-encoding in segment "${seg}"`)
        }
        if (decoded === '.' || decoded === '..') return refuse('arg.path must not contain "." or ".." segments')
        if (decoded.includes('/') || decoded.includes('\\')) return refuse('arg.path must not encode "/" or "\\" inside a segment')
        if (CONTROL.test(decoded)) return refuse('arg.path must not encode control characters')
        canonical.push(encodeSegment(decoded))
    }
    const path = `/${canonical.join('/')}`

    if (queryPart === undefined || queryPart === '') {
        return {ok: true, path, ...(params !== undefined ? {params} : {})}
    }
    const merged: Record<string, unknown> = {...(params ?? {})}
    const seen = new Set<string>()
    for (const [key, value] of new URLSearchParams(queryPart)) {
        if (seen.has(key)) return refuse(`query parameter "${key}" appears more than once in arg.path — pass it in arg.params`)
        if (Object.prototype.hasOwnProperty.call(merged, key)) {
            return refuse(`query parameter "${key}" is given both in arg.path and in arg.params`)
        }
        seen.add(key)
        merged[key] = value
    }
    return {ok: true, path, params: merged}
}

/**
 * RFC 3986 `pchar` stays literal (unreserved, sub-delims, `:` and `@`);
 * everything else is percent-encoded. So `%6f` becomes `o`, a space becomes
 * `%20`, and every equivalent spelling of a segment collapses to one.
 */
function encodeSegment(decoded: string): string {
    return encodeURIComponent(decoded).replace(/%(24|26|2B|2C|3B|3D|3A|40)/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)))
}

function refuse(detail: string): CanonicalRequestPath {
    return {ok: false, detail: `api.request(arg): ${detail}`}
}

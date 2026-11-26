// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {IncomingMessage, ServerResponse} from 'node:http'
import {HttpError} from './http-error.js'
import {ERR, HTTP_HEADER} from '../../core/constants.js'

/**
 * Reads a request body as UTF-8 text, never holding more than `maxBytes`.
 *
 * Why: the MCP adapter (and a naive reader) buffers whatever the client
 * sends, before any token is validated — one large POST could exhaust the
 * gateway's memory. A declared Content-Length over the limit is refused
 * without reading; a streamed body is counted as it arrives. Either way the
 * caller gets a 413 HttpError carrying `Connection: close`, and the socket is
 * closed once that response has been written (destroying it first would
 * leave the client with a reset instead of a status).
 */
export async function readBoundedBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<string> {
    const refuse = (): HttpError => {
        req.pause()
        res.once('finish', () => req.destroy())
        return new HttpError(413, ERR.PAYLOAD_TOO_LARGE, `Request body exceeds ${maxBytes} bytes`, undefined, {maxBytes}, {[HTTP_HEADER.CONNECTION]: 'close'})
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) throw refuse()

    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        const onData = (chunk: Buffer): void => {
            size += chunk.length
            if (size > maxBytes) {
                req.off('data', onData)
                reject(refuse())
                return
            }
            chunks.push(chunk)
        }
        req.on('data', onData)
        req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.once('error', reject)
    })
}

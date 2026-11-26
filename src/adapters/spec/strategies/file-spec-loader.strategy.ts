// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {readFile} from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import SwaggerParser from '@apidevtools/swagger-parser'
import type {OpenAPISpec} from '../../../core/types/spec.types.js'
import {SpecLoadError} from '../../../core/types/spec.types.js'
import type {SpecLoaderStrategy} from '../../../spi/spec/spec-loader.js'
import {errorMessage} from '../../../core/utils/errors.js'

export class FileSpecLoaderStrategy implements SpecLoaderStrategy {
    readonly name = 'file-spec-loader'

    constructor(private readonly filePath: string) {
    }

    async load(): Promise<OpenAPISpec> {
        try {
            const contents = await readFile(this.filePath, 'utf-8')
            const ext = path.extname(this.filePath).toLowerCase()

            let parsed: unknown
            if (ext === '.json') {
                parsed = JSON.parse(contents)
            } else {
                parsed = yaml.load(contents)
            }

            // The file's own path is the base for relative $refs (`schemas.yaml`
            // next to spec.yaml) — dereferencing the parsed object alone resolved
            // them against the process's working directory, so every refresh of a
            // multi-file spec failed (or read a same-named file from elsewhere).
            const dereferenced = await SwaggerParser.dereference(
                path.resolve(this.filePath),
                parsed as Parameters<typeof SwaggerParser.dereference>[0],
                {}
            )
            return dereferenced as OpenAPISpec
        } catch (err) {
            if (err instanceof SpecLoadError) throw err
            throw new SpecLoadError(
                `Failed to load spec from file "${this.filePath}": ${errorMessage(err)}`,
                err
            )
        }
    }
}

export function fileSpec(filePath: string): SpecLoaderStrategy {
    return new FileSpecLoaderStrategy(filePath)
}

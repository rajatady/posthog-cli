import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import { VERSION } from '../src/lib/version'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Prevents shipping a release where VERSION in src/ doesn't match package.json.
 * The User-Agent header and `--version` flag read from VERSION; drift here means
 * published binaries misreport themselves. prepublishOnly runs `npm test`, so
 * this test fails the release if the two ever diverge.
 */
describe('VERSION', () => {
    it('matches the version in package.json', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
            version: string
        }
        expect(VERSION).toBe(pkg.version)
    })
})

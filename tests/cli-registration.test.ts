import { Command } from 'commander'
import { describe, it, expect } from 'vitest'

import { registerToolCommand } from '../src/commands/tool'
import { loadRegistry } from '../src/lib/registry'

/**
 * Regression guard: every registered tool must be addable to commander without throwing.
 * This caught `id__in` (Django-style) param names producing `--id--in` which tripped
 * commander's internal camelcase helper. If a new PostHog param name shape breaks
 * registration, this test fails loudly instead of blowing up at CLI startup.
 */
describe('commander registration', () => {
    it('every tool with an HTTP spec registers without throwing', () => {
        const registry = loadRegistry()
        const program = new Command().name('thehogcli')

        let registered = 0
        for (const [slug, mod] of Object.entries(registry.modules)) {
            const moduleCmd = program.command(slug)
            for (const toolName of mod.tools) {
                const tool = registry.tools[toolName]!
                if (!tool.http) continue
                expect(() => registerToolCommand(moduleCmd, { toolName, tool })).not.toThrow()
                registered++
            }
        }
        // 231 = 262 total minus the 31 handwritten v1 tools without HTTP specs.
        expect(registered).toBe(231)
    })

    /**
     * Regression guard for the full tree, including handwritten tools with
     * per-field schemas. This catches cases like `get-llm-total-costs-for-project`
     * declaring a `projectId` prop whose kebab form collides with the CLI's
     * reserved `--project-id`.
     */
    it('every tool in the registry registers without throwing', () => {
        const registry = loadRegistry()
        const program = new Command().name('thehogcli')
        for (const [slug, mod] of Object.entries(registry.modules)) {
            const moduleCmd = program.command(slug)
            for (const toolName of mod.tools) {
                const tool = registry.tools[toolName]!
                expect(
                    () => registerToolCommand(moduleCmd, { toolName, tool }),
                    `${toolName} failed to register`
                ).not.toThrow()
            }
        }
    })

    it('feature-flag-get-all surfaces its query params as flags', () => {
        const registry = loadRegistry()
        const program = new Command()
        const tool = registry.tools['feature-flag-get-all']!
        const cmd = registerToolCommand(program, { toolName: 'feature-flag-get-all', tool })

        const flags = cmd.options.map((o) => o.long)
        expect(flags).toContain('--why')
        expect(flags).toContain('--dry-run')
        expect(flags).toContain('--search')
        expect(flags).toContain('--limit')
        expect(flags).toContain('--tags')
    })
})

#!/usr/bin/env node
import { Command } from 'commander'
import kleur from 'kleur'

import { registerHistoryCommands } from './commands/history.js'
import { registerLoginCommand } from './commands/login.js'
import { registerToolCommand } from './commands/tool.js'
import { configureNet } from './lib/net.js'
import { loadRegistry } from './lib/registry.js'
import { VERSION } from './lib/version.js'

function main(): void {
    configureNet()
    const registry = loadRegistry()

    const program = new Command()
        .name('thehogcli')
        .description(
            `PostHog CLI. ${Object.keys(registry.tools).length} tools across ${Object.keys(registry.modules).length} modules — every call captured in .thehogcli/history.db.\n\nPinned to PostHog @ ${registry.posthogSha.slice(0, 7)}`
        )
        .version(VERSION)
        .showHelpAfterError()

    registerLoginCommand(program)
    registerHistoryCommands(program)

    const moduleSlugs = Object.keys(registry.modules).sort()
    for (const slug of moduleSlugs) {
        const mod = registry.modules[slug]!
        const moduleCmd = program
            .command(slug)
            .description(`${mod.title} — ${mod.tools.length} tools. Run \`thehogcli ${slug} --help\` to list.`)

        for (const toolName of mod.tools) {
            const tool = registry.tools[toolName]!
            registerToolCommand(moduleCmd, { toolName, tool })
        }
    }

    program.configureHelp({
        sortSubcommands: true,
    })

    program.parseAsync(process.argv).catch((err: unknown) => {
        console.error(kleur.red(`fatal: ${err instanceof Error ? err.message : String(err)}`))
        process.exit(1)
    })
}

main()

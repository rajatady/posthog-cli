import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
        exclude: ['node_modules', 'dist', 'posthog'],
        coverage: {
            provider: 'v8',
            include: ['src/**', 'build/**'],
            exclude: ['**/*.test.ts', 'src/registry.json'],
        },
    },
})

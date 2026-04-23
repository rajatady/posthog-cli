// Fixture copied verbatim from posthog/services/mcp/src/tools/generated/feature_flags.ts
// (pinned SHA 46300d4). Trimmed to one list, one retrieve-by-id, one POST, one PATCH,
// one DELETE. Do not reformat — regex extractor tracks the generator's output layout.
// If PostHog changes the generator and this fixture is re-synced, tests will flag drift.
// This file is read as text by the extractor; it is never compiled or imported at runtime.
/* eslint-disable */
// @ts-nocheck
import { z } from 'zod'

import type { Schemas } from '@/api/generated'
import { withPostHogUrl, pickResponseFields, type WithPostHogUrl } from '@/tools/tool-utils'
import type { Context, ToolBase } from '@/tools/types'

const FeatureFlagGetAllSchema = {} as any
const FeatureFlagGetDefinitionSchema = {} as any
const CreateFeatureFlagSchema = {} as any
const UpdateFeatureFlagSchema = {} as any
const DeleteFeatureFlagSchema = {} as any

const featureFlagGetAll = (): ToolBase<
    typeof FeatureFlagGetAllSchema,
    WithPostHogUrl<Schemas.PaginatedFeatureFlagList>
> => ({
    name: 'feature-flag-get-all',
    schema: FeatureFlagGetAllSchema,
    handler: async (context: Context, params: z.infer<typeof FeatureFlagGetAllSchema>) => {
        const projectId = await context.stateManager.getProjectId()
        const result = await context.api.request<Schemas.PaginatedFeatureFlagList>({
            method: 'GET',
            path: `/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/`,
            query: {
                active: params.active,
                created_by_id: params.created_by_id,
                limit: params.limit,
                offset: params.offset,
                search: params.search,
                tags: params.tags,
            },
        })
        return result
    },
})

const featureFlagGetDefinition = (): ToolBase<
    typeof FeatureFlagGetDefinitionSchema,
    WithPostHogUrl<Schemas.FeatureFlag>
> => ({
    name: 'feature-flag-get-definition',
    schema: FeatureFlagGetDefinitionSchema,
    handler: async (context: Context, params: z.infer<typeof FeatureFlagGetDefinitionSchema>) => {
        const projectId = await context.stateManager.getProjectId()
        const result = await context.api.request<Schemas.FeatureFlag>({
            method: 'GET',
            path: `/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/`,
        })
        return result
    },
})

const createFeatureFlag = (): ToolBase<typeof CreateFeatureFlagSchema, WithPostHogUrl<Schemas.FeatureFlag>> => ({
    name: 'create-feature-flag',
    schema: CreateFeatureFlagSchema,
    handler: async (context: Context, params: z.infer<typeof CreateFeatureFlagSchema>) => {
        const projectId = await context.stateManager.getProjectId()
        const body: Record<string, unknown> = {}
        if (params.key !== undefined) {
            body['key'] = params.key
        }
        if (params.name !== undefined) {
            body['name'] = params.name
        }
        if (params.filters !== undefined) {
            body['filters'] = params.filters
        }
        if (params.active !== undefined) {
            body['active'] = params.active
        }
        const result = await context.api.request<Schemas.FeatureFlag>({
            method: 'POST',
            path: `/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/`,
            body,
        })
        return result
    },
})

const updateFeatureFlag = (): ToolBase<typeof UpdateFeatureFlagSchema, WithPostHogUrl<Schemas.FeatureFlag>> => ({
    name: 'update-feature-flag',
    schema: UpdateFeatureFlagSchema,
    handler: async (context: Context, params: z.infer<typeof UpdateFeatureFlagSchema>) => {
        const projectId = await context.stateManager.getProjectId()
        const body: Record<string, unknown> = {}
        if (params.key !== undefined) {
            body['key'] = params.key
        }
        if (params.name !== undefined) {
            body['name'] = params.name
        }
        const result = await context.api.request<Schemas.FeatureFlag>({
            method: 'PATCH',
            path: `/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/`,
            body,
        })
        return result
    },
})

const deleteFeatureFlag = (): ToolBase<typeof DeleteFeatureFlagSchema, WithPostHogUrl<Schemas.FeatureFlag>> => ({
    name: 'delete-feature-flag',
    schema: DeleteFeatureFlagSchema,
    handler: async (context: Context, params: z.infer<typeof DeleteFeatureFlagSchema>) => {
        const projectId = await context.stateManager.getProjectId()
        const result = await context.api.request<Schemas.FeatureFlag>({
            method: 'DELETE',
            path: `/api/projects/${encodeURIComponent(String(projectId))}/feature_flags/${encodeURIComponent(String(params.id))}/`,
        })
        return result
    },
})

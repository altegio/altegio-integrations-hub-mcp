import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { safeError } from './errors.js';
import { redactSecrets } from './redact.js';
import { buildTools, type ToolSpec } from './tools.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const docsDirectory = resolve(currentDirectory, '..', 'docs');

const resources = [
  {
    uri: 'altegio://marketplace/internals',
    name: 'marketplace_internals',
    title: 'Marketplace internals guide',
    description:
      'Source-referenced Biz.ERP architecture, state machine, payloads, frames, callbacks, billing, caches, gates, and limitations.',
    file: 'marketplace-internals.md',
  },
  {
    uri: 'altegio://marketplace/safe-e2e',
    name: 'marketplace_safe_e2e',
    title: 'Safe draft-to-install workflow',
    description:
      'A plan-first end-to-end recipe for creating, configuring, installing, activating, checking, updating, and uninstalling a draft.',
    file: 'safe-e2e.md',
  },
  {
    uri: 'altegio://marketplace/tool-boundaries',
    name: 'marketplace_tool_boundaries',
    title: 'Tool and API boundaries',
    description:
      'Public, Developer Cabinet, restricted, and internal backoffice surface classification.',
    file: 'tool-boundaries.md',
  },
] as const;

function toTool(spec: ToolSpec): Tool {
  const jsonSchema = z.toJSONSchema(spec.schema) as Tool['inputSchema'];
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchema,
    annotations: {
      readOnlyHint: spec.readOnly,
      destructiveHint: spec.destructive,
      idempotentHint: spec.readOnly,
      openWorldHint: true,
    },
  };
}

export function createServer(config: Config): Server {
  const server = new Server(
    { name: '@altegio/marketplace-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions:
        'Automate Altegio Marketplace application lifecycle. Start with read tools and mode=plan. Developer Cabinet operations use the caller Altegio token. Partner actions verify application ownership. Internal backoffice tools are disabled by default. Read altegio://marketplace/tool-boundaries before using restricted surfaces.',
    }
  );
  const specs = buildTools(config).sort((left, right) => left.name.localeCompare(right.name));
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: specs.map(toTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = byName.get(request.params.name);
    if (!spec) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    try {
      const result = redactSecrets(await spec.handler(request.params.arguments ?? {}));
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent:
          result && typeof result === 'object' ? (result as Record<string, unknown>) : { result },
      };
    } catch (error) {
      const result = redactSecrets(safeError(error)) as Record<string, unknown>;
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: 'text/markdown',
    })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find((item) => item.uri === request.params.uri);
    if (!resource)
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: 'text/markdown',
          text: await readFile(resolve(docsDirectory, resource.file), 'utf8'),
        },
      ],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'marketplace_safe_draft_rollout',
        description:
          'Drive a safe draft application rollout with plan/apply checkpoints and final cleanup.',
        arguments: [
          { name: 'partner_id', description: 'Developer account ID', required: true },
          { name: 'location_id', description: 'Dedicated test location ID', required: true },
        ],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'marketplace_safe_draft_rollout') {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
    }
    const partnerId = request.params.arguments?.partner_id;
    const locationId = request.params.arguments?.location_id;
    if (!partnerId || !locationId)
      throw new McpError(ErrorCode.InvalidParams, 'partner_id and location_id are required');
    return {
      description: 'Safe draft rollout',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use developer account ${partnerId} and dedicated test location ${locationId}. Read altegio://marketplace/safe-e2e, inspect current accounts/metadata/rights, and run every mutation with mode=plan before mode=apply. Keep the app non-public/draft, request minimum permissions, verify pending/active state and callbacks, update one reversible field, verify again, then only uninstall if I explicitly provide the tool's exact confirmation phrase. Never invoke backoffice publication.`,
          },
        },
      ],
    };
  });

  return server;
}

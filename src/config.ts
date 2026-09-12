import { resolve } from 'node:path';
import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

export const ConfigSchema = z.object({
  ALTEGIO_PARTNER_TOKEN: z.string().min(1),
  ALTEGIO_USER_TOKEN: z.string().min(1).optional(),
  ALTEGIO_ADMIN_USER_TOKEN: z.string().min(1).optional(),
  ALTEGIO_API_BASE: z.string().url().default('https://api.alteg.io/api/v1'),
  ALTEGIO_APP_BASE: z.string().url().default('https://app.alteg.io'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8094),
  ALLOW_BACKOFFICE: booleanFlag,
  MARKETPLACE_MCP_STATE_DIR: z.string().default('.marketplace-mcp'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  return {
    ...parsed,
    MARKETPLACE_MCP_STATE_DIR: resolve(parsed.MARKETPLACE_MCP_STATE_DIR),
  };
}

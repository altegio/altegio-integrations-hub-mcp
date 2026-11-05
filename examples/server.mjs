// Run after npm ci and npm run build. This example performs no upstream request.
import { createServer } from '@altegio/integrations-hub-mcp';
import { loadConfig } from '@altegio/integrations-hub-mcp/config';

const server = createServer(loadConfig({ ALTEGIO_PARTNER_TOKEN: 'synthetic-example' }));
await server.close();
console.log('Library import and configuration succeeded');

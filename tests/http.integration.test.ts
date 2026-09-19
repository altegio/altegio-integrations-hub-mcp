import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http-server.js';
import { testConfig } from './helpers.js';

describe('HTTP transport', () => {
  test('health and MCP initialize work', async () => {
    const { app } = createApp({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-token' });
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const port = (listener.address() as AddressInfo).port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await health.json()).toEqual({ status: 'ok' });

      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'integration-test', version: '1.0.0' },
          },
        }),
      });
      expect(response.status).toBe(200);
      const sessionId = response.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      expect(await response.text()).toContain('@altegio/marketplace-mcp');

      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        }),
      });
      const tools = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const toolList = await tools.text();
      expect(tools.status).toBe(200);
      expect(toolList).toContain('marketplace_create_application');
      expect(toolList).toContain('marketplace_validate_lifecycle_callback');
      expect(toolList).toContain('marketplace_list_entity_frames');
      expect(toolList).toContain('marketplace_replace_entity_frames');
      expect(toolList).toContain('marketplace_install_sidebar_frame');
      expect(toolList).toContain('outputSchema');
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

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
      expect(await response.text()).toContain('@altegio/integrations-hub-mcp');

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
      expect(toolList).toContain('integrations_hub_create_application');
      expect(toolList).toContain('integrations_hub_validate_lifecycle_callback');
      expect(toolList).toContain('integrations_hub_list_entity_frames');
      expect(toolList).toContain('integrations_hub_replace_entity_frames');
      expect(toolList).toContain('integrations_hub_install_sidebar_frame');
      expect(toolList).toContain('outputSchema');
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

/**
 * Streamable HTTP session status codes, over the real SDK transport. Sessions live in process
 * memory, so a restart forgets them all: a client still holding one must get 404, which tells it
 * to start a new session with `initialize`. 400 is only for a request with no session ID at all.
 */
describe('HTTP session status codes', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'session-test', version: '1.0.0' },
    },
  };
  const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const SESSION_NOT_FOUND = {
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  };

  const send = (
    port: number,
    method: 'POST' | 'GET' | 'DELETE',
    sessionId: string | null,
    body?: unknown
  ): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: { ...MCP_HEADERS, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const withApp = async (
    run: (port: number, created: ReturnType<typeof createApp>) => Promise<void>
  ): Promise<void> => {
    const created = createApp({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-token' });
    const listener = created.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    try {
      await run((listener.address() as AddressInfo).port, created);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };

  test('answers 404 for a session this process does not hold, on every method', async () => {
    await withApp(async (port) => {
      const stale = '6f1c2a4e-0000-4000-8000-000000000000';

      const post = await send(port, 'POST', stale, TOOLS_LIST);
      expect(post.status).toBe(404);
      expect(await post.json()).toEqual(SESSION_NOT_FOUND);

      // Even `initialize` carrying a dead session is refused: the client must drop the old ID.
      const init = await send(port, 'POST', stale, INITIALIZE);
      expect(init.status).toBe(404);
      expect(await init.json()).toEqual(SESSION_NOT_FOUND);

      const get = await send(port, 'GET', stale);
      expect(get.status).toBe(404);
      expect(await get.json()).toEqual(SESSION_NOT_FOUND);

      const del = await send(port, 'DELETE', stale);
      expect(del.status).toBe(404);
      expect(await del.json()).toEqual(SESSION_NOT_FOUND);

      // A prototype key is not a session either.
      for (const method of ['POST', 'GET', 'DELETE'] as const) {
        const response = await send(
          port,
          method,
          'constructor',
          method === 'POST' ? TOOLS_LIST : undefined
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(SESSION_NOT_FOUND);
      }
    });
  });

  test('answers 400 only when the session ID is missing', async () => {
    await withApp(async (port) => {
      for (const method of ['POST', 'GET', 'DELETE'] as const) {
        const response = await send(port, method, null, method === 'POST' ? TOOLS_LIST : undefined);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Missing session ID' },
          id: null,
        });
      }
    });
  });

  test('answers 404 once a session is terminated, and a fresh initialize recovers', async () => {
    await withApp(async (port, { transports }) => {
      const init = await send(port, 'POST', null, INITIALIZE);
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id')!;
      await init.text();
      expect(Object.keys(transports)).toContain(sessionId);

      expect((await send(port, 'DELETE', sessionId)).status).toBe(200);
      expect(Object.keys(transports)).not.toContain(sessionId);

      // Same as after a restart: the ID is gone, so every method answers 404 ...
      const stale = await send(port, 'POST', sessionId, TOOLS_LIST);
      expect(stale.status).toBe(404);
      expect(await stale.json()).toEqual(SESSION_NOT_FOUND);
      expect((await send(port, 'GET', sessionId)).status).toBe(404);
      expect((await send(port, 'DELETE', sessionId)).status).toBe(404);

      // ... and the client's next step, a new initialize, gets a new working session.
      const again = await send(port, 'POST', null, INITIALIZE);
      expect(again.status).toBe(200);
      const next = again.headers.get('mcp-session-id');
      await again.text();
      expect(next).toBeTruthy();
      expect(next).not.toBe(sessionId);

      const tools = await send(port, 'POST', next, TOOLS_LIST);
      expect(tools.status).toBe(200);
      expect(await tools.text()).toContain('integrations_hub_create_application');
    });
  });
});

describe('HTTP session retention', () => {
  test('bounds initialized servers and reclaims idle transports', async () => {
    const { app, transports } = createApp(
      { ...testConfig, MCP_HTTP_MAX_SESSIONS: 1 },
      { idleTimeoutMs: 100 }
    );
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const port = (listener.address() as AddressInfo).port;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const url = `http://127.0.0.1:${port}/mcp`;
    const initialize = (): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'abandoned-client', version: '1' },
          },
        }),
      });
    try {
      const first = await initialize();
      await first.text();
      expect(first.status).toBe(200);
      const sessionId = first.headers.get('mcp-session-id')!;
      const blocked = await initialize();
      await blocked.text();
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('60');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(Object.keys(transports)).toHaveLength(0);
      const stale = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
      await stale.text();
      expect(stale.status).toBe(404);
      const replacement = await initialize();
      await replacement.text();
      expect(replacement.status).toBe(200);
    } finally {
      for (const transport of Object.values(transports)) await transport.close();
      listener.close();
    }
  });
});

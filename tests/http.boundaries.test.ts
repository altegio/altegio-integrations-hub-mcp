import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createApp } from '../src/http-server.js';
import { testConfig } from './helpers.js';

describe('HTTP request boundaries', () => {
  let server: Server;
  let created: ReturnType<typeof createApp>;
  let url: string;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'boundaries', version: '1' },
    },
  };
  beforeEach(async () => {
    created = createApp({ ...testConfig, ALTEGIO_USER_TOKEN: 'stdio-only-secret' });
    server = created.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterEach(async () => {
    await Promise.all(Object.values(created.transports).map((transport) => transport.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.each<Record<string, string>>([
    { host: 'attacker.example' },
    { origin: 'https://attacker.example' },
    { origin: 'null' },
  ])('rejects untrusted headers before session allocation: %j', async (extra) => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, ...extra } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
    expect(Object.keys(created.transports)).toHaveLength(0);
  });

  test('accepts the configured browser origin and hides parser diagnostics', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'https://client.example.test' },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    await response.text();
    const bad = await fetch(url, { method: 'POST', headers, body: '{"token":"synthetic-secret"' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('synthetic-secret');
  });

  test('keeps concurrent callers isolated on a retained session and refuses a missing HTTP identity', async () => {
    const nativeFetch = globalThis.fetch;
    const authorizations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith(testConfig.ALTEGIO_API_BASE)) {
        const authorization = new Headers(init?.headers).get('authorization')!;
        authorizations.push(authorization);
        await new Promise((resolve) =>
          setTimeout(resolve, authorization.includes('caller-a') ? 20 : 1)
        );
        return new Response(
          JSON.stringify({
            data: [{ title: authorization.includes('caller-a') ? 'Account A' : 'Account B' }],
          })
        );
      }
      return nativeFetch(input, init);
    });
    const initialized = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    const session = initialized.headers.get('mcp-session-id')!;
    await initialized.text();
    const call = async (id: number, token?: string): Promise<string> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'mcp-session-id': session,
          ...(token ? { 'x-altegio-user-token': token } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'integrations_hub_list_developer_accounts', arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    const [a, b] = await Promise.all([call(2, 'caller-a'), call(3, 'caller-b')]);
    expect(a).toContain('Account A');
    expect(a).not.toContain('Account B');
    expect(b).toContain('Account B');
    expect(await call(4)).toContain('An Altegio user token is required');
    expect(authorizations.sort()).toEqual([
      'Bearer partner-test-token, User caller-a',
      'Bearer partner-test-token, User caller-b',
    ]);
  });
});

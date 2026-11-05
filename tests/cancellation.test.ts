import { expect, test, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.js';
import { MarketplaceClient } from '../src/client.js';
import { runWithContext } from '../src/context.js';
import { testConfig } from './helpers.js';

test('a cancelled call never starts an upstream request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(
    runWithContext({ signal: AbortSignal.abort() }, () =>
      new MarketplaceClient(testConfig).request('/unused', { lane: 'partner' })
    )
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

test('MCP cancellation aborts the originating upstream fetch without replay', async () => {
  const server = createServer({ ...testConfig, ALTEGIO_USER_TOKEN: 'synthetic-stdio-user' });
  const client = new Client({ name: 'cancellation-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted.resolve();
          reject(init!.signal!.reason);
        },
        { once: true }
      );
    });
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'integrations_hub_list_developer_accounts', arguments: {} },
      { signal: controller.signal }
    );
    const refused = expect(call).rejects.toThrow();
    await started.promise;
    controller.abort();
    await refused;
    await aborted.promise;
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});

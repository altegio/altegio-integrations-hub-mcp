import { jest } from '@jest/globals';
import { MarketplaceClient } from '../src/client.js';
import { runWithContext } from '../src/context.js';
import { testConfig } from './helpers.js';

describe('MarketplaceClient', () => {
  afterEach(() => jest.restoreAllMocks());

  test('uses the request-scoped user token without putting it in the URL', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const client = new MarketplaceClient(testConfig);
    await runWithContext({ userToken: 'caller-token' }, () =>
      client.request('/marketplace/developers/companies', { lane: 'user' })
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain('caller-token');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer partner-test-token, User caller-token'
    );
  });

  test('partner lane never adds a user token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new MarketplaceClient({ ...testConfig, ALTEGIO_USER_TOKEN: 'stored-user' });
    await client.request('/marketplace/partner/callback', { lane: 'partner', host: 'app' });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer partner-test-token'
    );
  });

  test('partner lane can use an owned developer-account token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new MarketplaceClient(testConfig);
    await client.request('/marketplace/partner/callback', {
      lane: 'partner',
      host: 'app',
      partnerToken: 'account-partner-token',
    });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('authorization')).toBe(
      'Bearer account-partner-token'
    );
  });

  test('extracts a partner token from a developer account relationship', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 3, partner_system: { data: { token: 'account-partner-token' } } }],
        }),
        { status: 200 }
      )
    );
    const client = new MarketplaceClient({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-token' });
    await expect(client.partnerTokenForAccount(3)).resolves.toBe('account-partner-token');
  });

  test('upstream error details are bounded to the parsed response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, meta: { message: 'denied' } }), {
        status: 403,
      })
    );
    await expect(
      new MarketplaceClient(testConfig).request('/private', { lane: 'partner' })
    ).rejects.toMatchObject({ status: 403, details: { message: 'denied' } });
  });
});

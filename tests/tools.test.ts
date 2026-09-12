import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/tools.js';
import { FakeClient, testConfig } from './helpers.js';

describe('tool contracts', () => {
  test('tool names are unique and surface is broad', () => {
    const tools = buildTools(testConfig, new FakeClient());
    expect(new Set(tools.map((item) => item.name)).size).toBe(tools.length);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(tools.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'marketplace_create_application',
        'marketplace_activate_installation',
        'marketplace_record_payment',
        'marketplace_get_statistics',
        'marketplace_replace_entity_frames',
        'marketplace_backoffice_set_publication',
      ])
    );
  });

  test('plan mode performs no write', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'marketplace_create_developer_account'
    )!;
    const result = await target.handler({
      mode: 'plan',
      account: {
        title: 'Company',
        description: 'Developer',
        name: 'Owner',
        phone: '+5511999999999',
        email: 'owner@example.com',
        website_url: 'https://example.com',
        legal_type: 'llc',
      },
    });
    expect(client.calls).toHaveLength(0);
    expect(result).toMatchObject({ applied: false });
  });

  test('catalog metadata includes the country dictionary', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'marketplace_get_catalog_metadata'
    )!;
    await target.handler({});
    expect(client.calls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        '/marketplace/applications/categories',
        '/countries',
        '/marketplace/applications/channels',
        '/marketplace/applications/functionalities',
      ])
    );
  });

  test('create application is idempotent by slug', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'marketplace_create_application'
    )!;
    const result = await target.handler({
      mode: 'apply',
      partner_id: 3,
      application: {
        title: 'Existing app',
        short_description: 'Existing app',
        category_id: 1,
        country_ids: [1],
        website_url: 'https://example.com',
        price: '0',
        trial_duration: 0,
        channels: [],
        permissions: {},
        callback_url: '',
        registration_redirect_url: '',
        is_personal_data_access_needed: false,
        is_multiple_salons_allowed: false,
        is_iframe: false,
        slug: 'ExistingApp',
        is_nonpublic: true,
        monetization_type: 'free',
      },
    });
    expect(client.calls).toHaveLength(0);
    expect(result).toMatchObject({ applied: false, idempotent: true });
  });

  test('partner activation uses normalized location input and legacy wire field', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'marketplace_activate_installation'
    )!;
    await target.handler({
      mode: 'apply',
      partner_id: 3,
      application_id: 7,
      location_id: 55,
      settings: { webhook_urls: ['https://example.com/hook'], channels: [] },
      confirmation: 'ACTIVATE APPLICATION 7 AT LOCATION 55',
    });
    const write = client.calls.find((call) => call.path === '/marketplace/partner/callback');
    expect(write?.options.body).toMatchObject({ salon_id: 55, application_id: 7 });
    expect(write?.options.partnerToken).toBe('owned-partner-token');
  });

  test('payment-link request includes the required tariff option', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'marketplace_get_payment_link'
    )!;
    await target.handler({
      partner_id: 3,
      application_id: 7,
      location_id: 55,
      tariff_option_id: 9,
      discount: 15,
    });
    expect(client.calls.at(-1)).toMatchObject({
      path: '/marketplace/application/payment_link',
      options: {
        query: { salon_id: 55, application_id: 7, tariff_option_id: 9, discount: 15 },
      },
    });
  });

  test('lifecycle validation uses the owned developer-account token', async () => {
    const target = buildTools(testConfig, new FakeClient()).find(
      (item) => item.name === 'marketplace_validate_lifecycle_callback'
    )!;
    await expect(
      target.handler({
        partner_id: 3,
        payload: {
          salon_id: 55,
          application_id: 7,
          event: 'uninstall',
          partner_token: 'owned-partner-token',
        },
      })
    ).resolves.toMatchObject({ valid: true, token_valid: true });
  });

  test('payment lifecycle validation checks the documented HMAC payload', async () => {
    const target = buildTools(testConfig, new FakeClient()).find(
      (item) => item.name === 'marketplace_validate_lifecycle_callback'
    )!;
    const sign = createHmac('sha256', 'owned-partner-token')
      .update('salon_id=55&amount=100&discount=5')
      .digest('hex');
    await expect(
      target.handler({
        partner_id: 3,
        payload: {
          salon_id: 55,
          application_id: 7,
          event: 'payment',
          partner_token: 'owned-partner-token',
          payment_id: 11,
          amount: 100,
          currency_iso: 'BRL',
          discount: 5,
          period_from: '2026-09-12 10:00:00',
          period_to: '2026-10-12 10:00:00',
          payment_date: '2026-09-12 10:00:00',
          tariff_option_id: 9,
          sign,
        },
      })
    ).resolves.toMatchObject({ valid: true, token_valid: true, signature_valid: true });
  });

  test('concurrent payment retries apply once per durable idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'marketplace-mcp-idempotency-'));
    try {
      const client = new FakeClient();
      const target = buildTools(
        { ...testConfig, MARKETPLACE_MCP_STATE_DIR: directory },
        client
      ).find((item) => item.name === 'marketplace_record_payment')!;
      const input = {
        mode: 'apply',
        partner_id: 3,
        application_id: 7,
        location_id: 55,
        currency_iso: 'BRL',
        payment_sum: 100,
        payment_date: '2026-09-12 10:00:00',
        period_from: '2026-09-12 10:00:00',
        period_to: '2026-10-12 10:00:00',
        idempotency_key: 'payment-55-2026-09',
        confirmation: 'RECORD PAYMENT FOR APPLICATION 7 AT LOCATION 55',
      };
      const results = await Promise.all([target.handler(input), target.handler(input)]);
      expect(
        client.calls.filter((call) => call.path === '/marketplace/partner/payment')
      ).toHaveLength(1);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ applied: true }),
          expect.objectContaining({ applied: false, idempotent: true }),
        ])
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('backoffice remains disabled by default', async () => {
    const target = buildTools(testConfig, new FakeClient()).find(
      (item) => item.name === 'marketplace_backoffice_get_application'
    )!;
    await expect(target.handler({ application_id: 7 })).rejects.toThrow('disabled');
  });
});

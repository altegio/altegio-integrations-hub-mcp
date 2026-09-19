import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildTools } from '../src/tools.js';
import { FakeClient, testConfig } from './helpers.js';

describe('tool contracts', () => {
  test('tool names are unique and surface is broad', () => {
    const tools = buildTools(testConfig, new FakeClient());
    expect(new Set(tools.map((item) => item.name)).size).toBe(tools.length);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    expect(tools.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        'integrations_hub_create_application',
        'integrations_hub_activate_installation',
        'integrations_hub_record_payment',
        'integrations_hub_get_statistics',
        'integrations_hub_replace_entity_frames',
        'integrations_hub_backoffice_set_publication',
      ])
    );
  });

  test('plan mode performs no write', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_create_developer_account'
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
      (item) => item.name === 'integrations_hub_get_catalog_metadata'
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
    expect(client.calls.every((call) => call.options.lane === 'user')).toBe(true);
  });

  test('existing application slugs with underscores remain editable', () => {
    const target = buildTools(testConfig, new FakeClient()).find(
      (item) => item.name === 'integrations_hub_update_application'
    )!;
    const parsed = target.schema.safeParse({
      mode: 'plan',
      partner_id: 3,
      application_id: 7,
      application: {
        title: 'Existing app',
        short_description: 'Existing app',
        category_id: 1,
        country_ids: [1],
        website_url: 'https://example.com',
        price: '',
        trial_duration: 0,
        channels: [],
        permissions: {},
        callback_url: '',
        registration_redirect_url: '',
        is_personal_data_access_needed: false,
        is_multiple_salons_allowed: false,
        is_iframe: false,
        slug: 'existing_app',
        is_nonpublic: false,
        monetization_type: 'free',
        full_description: 'Existing app description',
        features_description: [],
        promo_materials: [],
        questions: [],
        functionalities: [],
      },
    });

    expect(parsed.success).toBe(true);
  });

  test('create application is idempotent by slug', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_create_application'
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

  test('application plan preserves embedded settings iframe configuration', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_create_application'
    )!;
    const result = await target.handler({
      mode: 'plan',
      partner_id: 3,
      application: {
        title: 'Iframe app',
        short_description: 'Iframe settings',
        category_id: 1,
        country_ids: [1],
        website_url: 'https://example.com',
        price: '0',
        trial_duration: 0,
        channels: [],
        permissions: {},
        registration_redirect_url: 'https://example.com/settings',
        is_iframe: true,
        slug: 'IframeApp',
        monetization_type: 'free',
      },
    });

    expect(client.calls).toHaveLength(0);
    expect(result).toMatchObject({
      applied: false,
      plan: {
        body: {
          registration_redirect_url: 'https://example.com/settings',
          is_iframe: true,
        },
      },
    });
  });

  test('partner activation uses normalized location input and legacy wire field', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_activate_installation'
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

  test('entity frame replacement rejects duplicate slugs', async () => {
    const target = buildTools(testConfig, new FakeClient()).find(
      (item) => item.name === 'integrations_hub_replace_entity_frames'
    )!;
    await expect(
      target.handler({
        mode: 'plan',
        partner_id: 3,
        application_id: 7,
        frames: [
          { title: 'Visit one', url: 'https://example.com/one', slug: 'visit' },
          { title: 'Visit two', url: 'https://example.com/two', slug: 'visit' },
        ],
      })
    ).rejects.toThrow('Only one visit declaration');
  });

  test('entity frame listing uses the owned Developer Cabinet route', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_list_entity_frames'
    )!;

    await target.handler({ partner_id: 3, application_id: 7 });

    expect(client.calls).toEqual([
      {
        path: '/marketplace/developers/companies/3/applications/7/frames',
        options: { lane: 'user' },
      },
    ]);
  });

  test('entity frame tools expose described input and output contracts', () => {
    const tools = buildTools(testConfig, new FakeClient());
    const list = tools.find((item) => item.name === 'integrations_hub_list_entity_frames')!;
    const replace = tools.find((item) => item.name === 'integrations_hub_replace_entity_frames')!;
    const toggle = tools.find((item) => item.name === 'integrations_hub_toggle_sidebar_highlight')!;
    const listInput = z.toJSONSchema(list.schema);
    const replaceInput = z.toJSONSchema(replace.schema);
    const listOutput = z.toJSONSchema(list.outputSchema!);

    expect(listInput.properties?.application_id).toMatchObject({
      description: 'Marketplace application ID owned by that account',
    });
    expect(replaceInput.properties?.frames).toMatchObject({
      description: expect.stringContaining('Complete replacement set'),
    });
    expect(listOutput.properties?.data).toMatchObject({
      description: 'Current declared entity iframe definitions',
    });
    expect(replace.destructive).toBe(true);
    expect(replace.outputSchema).toBeDefined();
    expect(toggle.outputSchema).toBeDefined();
  });

  test('entity frame replacement reads declarations back after applying', async () => {
    const client = new FakeClient();
    const path = '/marketplace/developers/companies/3/applications/7/frames';
    client.responses.set(path, {
      success: true,
      data: [{ title: 'Employee', url: 'https://example.com/frame', slug: 'employee' }],
    });
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_replace_entity_frames'
    )!;
    const result = await target.handler({
      mode: 'apply',
      partner_id: 3,
      application_id: 7,
      frames: [{ title: 'Employee', url: 'https://example.com/frame', slug: 'employee' }],
      confirmation: 'REPLACE FRAMES FOR APPLICATION 7',
    });

    expect(client.calls.filter((call) => call.path === path)).toHaveLength(2);
    expect(result).toMatchObject({
      verification: {
        declarations_read_back: { success: true },
        existing_installations_updated: false,
      },
    });
  });

  test('sidebar frame installation reports its effective result as unverified', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_install_sidebar_frame'
    )!;
    const result = await target.handler({
      mode: 'apply',
      partner_id: 3,
      application_id: 7,
      location_id: 55,
      type: 'chat',
      url: 'https://example.com/chat',
      confirmation: 'INSTALL chat FRAME FOR APPLICATION 7 AT LOCATION 55',
    });

    expect(client.calls.map((call) => call.path)).toEqual(
      expect.arrayContaining([
        '/marketplace/application/install_frame',
        '/marketplace/salon/55/application/7',
      ])
    );
    expect(result).toMatchObject({
      verification: { effective_sidebar_frame_verified: false, outcome: 'unverified' },
    });
    expect(target.destructive).toBe(true);
    expect(target.outputSchema).toBeDefined();
  });

  test('sidebar frame removal requires an explicit remove confirmation', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_install_sidebar_frame'
    )!;
    const input = {
      mode: 'apply' as const,
      partner_id: 3,
      application_id: 7,
      location_id: 55,
      type: 'chat' as const,
      url: null,
    };

    await expect(
      target.handler({
        ...input,
        confirmation: 'INSTALL chat FRAME FOR APPLICATION 7 AT LOCATION 55',
      })
    ).rejects.toThrow('REMOVE chat FRAME FOR APPLICATION 7 AT LOCATION 55');
    expect(client.calls).toHaveLength(0);

    await target.handler({
      ...input,
      confirmation: 'REMOVE chat FRAME FOR APPLICATION 7 AT LOCATION 55',
    });
    expect(
      client.calls.find((call) => call.path === '/marketplace/application/install_frame')
    ).toMatchObject({ options: { body: { type: 'chat', url: null } } });
  });

  test('payment-link request includes the required tariff option', async () => {
    const client = new FakeClient();
    const target = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_get_payment_link'
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
      (item) => item.name === 'integrations_hub_validate_lifecycle_callback'
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
      (item) => item.name === 'integrations_hub_validate_lifecycle_callback'
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
    const directory = await mkdtemp(join(tmpdir(), 'integrations-hub-mcp-idempotency-'));
    try {
      const client = new FakeClient();
      const target = buildTools(
        { ...testConfig, INTEGRATIONS_HUB_MCP_STATE_DIR: directory },
        client
      ).find((item) => item.name === 'integrations_hub_record_payment')!;
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
      (item) => item.name === 'integrations_hub_backoffice_get_application'
    )!;
    await expect(target.handler({ application_id: 7 })).rejects.toThrow('disabled');
  });
});

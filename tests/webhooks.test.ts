import { buildTools } from '../src/tools.js';
import { eventFields, parseHookSettings, planHookChange } from '../src/webhooks.js';
import { FakeClient, testConfig } from './helpers.js';

const settings = {
  urls: ['http://legacy.example/hook', 'https://existing.example/hook'],
  active: 1,
  salon: 1,
  master: 0,
  service: 1,
  service_category: 0,
  client: 1,
  record: 1,
  loyalty_card: 0,
  goods_operations_sale: 1,
  goods_operations_receipt: 0,
  goods_operations_consumable: 0,
  goods_operations_stolen: 0,
  goods_operations_move: 1,
  finances_operation: 0,
};

const base = { partner_id: 3, application_id: 7, location_id: 55 };
const change = {
  action: 'add_destination',
  url: 'https://new.example/hook',
  product: true,
  self_sending: false,
  overwrite_shared_settings: true,
};

describe('location webhooks', () => {
  test('canonical read shows gaps in upstream settings and a stable snapshot', async () => {
    const client = new FakeClient();
    client.responses.set('/hooks_settings/55', { success: true, data: settings });
    const tool = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_get_location_webhooks'
    )!;
    const result = await tool.handler(base);
    expect(result).toMatchObject({
      urls: settings.urls,
      events: { location: true, team_member: false, product: null },
      unreadable_fields: ['product', 'self_sending'],
    });
    expect(client.calls).toEqual([{ path: '/hooks_settings/55', options: { lane: 'user' } }]);
  });

  test('plan preserves all URLs and visible flags without a write', async () => {
    const client = new FakeClient();
    client.responses.set('/hooks_settings/55', { success: true, data: settings });
    const tool = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_change_location_webhooks'
    )!;
    const result = await tool.handler({ ...base, mode: 'plan', change });
    expect(result).toMatchObject({
      applied: false,
      expected_snapshot: expect.stringMatching(/^[a-f0-9]{64}$/),
      plan: {
        body: {
          urls: [...settings.urls, change.url],
          active: 1,
          salon: 1,
          master: 0,
          good: 1,
          self_sending: 0,
        },
      },
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].options.method).toBeUndefined();
  });

  test('apply requires the snapshot and confirmation, then verifies the read-back', async () => {
    class WritingClient extends FakeClient {
      override async request(
        path: string,
        options: Parameters<FakeClient['request']>[1]
      ): Promise<unknown> {
        if (options.method === 'POST')
          this.responses.set(path, { success: true, data: options.body });
        return super.request(path, options);
      }
    }
    const client = new WritingClient();
    client.responses.set('/hooks_settings/55', { success: true, data: settings });
    const tool = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_change_location_webhooks'
    )!;
    const expected_snapshot = parseHookSettings({ data: settings }).snapshot;
    await expect(
      tool.handler({ ...base, mode: 'apply', change, expected_snapshot })
    ).rejects.toThrow('Confirmation required');
    expect(client.calls.every((call) => call.options.method !== 'POST')).toBe(true);
    const result = await tool.handler({
      ...base,
      mode: 'apply',
      change,
      expected_snapshot,
      confirmation: 'CHANGE LOCATION 55 WEBHOOKS',
    });
    expect(result).toMatchObject({
      applied: true,
      verification: { urls: [...settings.urls, change.url] },
    });
    expect(client.calls.filter((call) => call.options.method === 'POST')).toHaveLength(1);
  });

  test('rejects stale plans, too many URLs, empty lists, and unsafe new URLs', async () => {
    const client = new FakeClient();
    client.responses.set('/hooks_settings/55', { success: true, data: settings });
    const tool = buildTools(testConfig, client).find(
      (item) => item.name === 'integrations_hub_change_location_webhooks'
    )!;
    await expect(
      tool.handler({
        ...base,
        mode: 'apply',
        change,
        expected_snapshot: '0'.repeat(64),
        confirmation: 'CHANGE LOCATION 55 WEBHOOKS',
      })
    ).rejects.toThrow('changed since planning');
    expect(client.calls.every((call) => call.options.method !== 'POST')).toBe(true);
    expect(() =>
      planHookChange(parseHookSettings({ data: settings }), {
        ...change,
        url: 'http://new.example/hook',
      })
    ).toThrow();
    const one = parseHookSettings({ data: { ...settings, urls: [settings.urls[0]] } });
    expect(() =>
      planHookChange(one, {
        action: 'remove_destination',
        url: settings.urls[0],
        product: false,
        self_sending: true,
        overwrite_shared_settings: false,
      })
    ).toThrow('at least one');
    const ten = parseHookSettings({
      data: { ...settings, urls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`) },
    });
    expect(() => planHookChange(ten, change)).toThrow('at most 10');
  });

  test('set_events changes only selected flags and keeps the supplied unreadable fields', () => {
    const current = parseHookSettings({ data: settings });
    expect(() => planHookChange(current, { ...change, overwrite_shared_settings: false })).toThrow(
      'Multiple destinations'
    );
    expect(() => planHookChange(current, { ...change, events: { product: false } })).toThrow(
      'disagree'
    );
    const body = planHookChange(current, {
      action: 'set_events',
      events: { appointment: false },
      product: true,
      self_sending: true,
      overwrite_shared_settings: true,
    });
    expect(body).toMatchObject({
      urls: settings.urls,
      record: 0,
      salon: 1,
      good: 1,
      self_sending: 1,
    });
    expect(Object.keys(eventFields)).toHaveLength(14);
  });
});

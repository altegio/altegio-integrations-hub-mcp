import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/tools.js';
import { FakeClient, testConfig } from './helpers.js';

const payment = {
  mode: 'apply',
  partner_id: 3,
  application_id: 7,
  location_id: 55,
  currency_iso: 'USD',
  payment_sum: 100,
  payment_date: '2026-10-01 10:00:00',
  period_from: '2026-10-01 10:00:00',
  period_to: '2026-11-01 10:00:00',
  idempotency_key: 'synthetic-payment-55',
  confirmation: 'RECORD PAYMENT FOR APPLICATION 7 AT LOCATION 55',
};

describe('durable financial operations', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hub-payments-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const record = (client: FakeClient, dir: string): ReturnType<typeof buildTools>[number] =>
    buildTools({ ...testConfig, INTEGRATIONS_HUB_MCP_STATE_DIR: dir }, client).find(
      (tool) => tool.name === 'integrations_hub_record_payment'
    )!;

  test('revalidates ownership before returning a stored payment', async () => {
    const client = new FakeClient();
    await record(client, directory).handler(payment);
    client.applications = [];
    await expect(record(client, directory).handler(payment)).rejects.toThrow('not owned');
  });

  test('does not replay an ambiguous payment after a new server instance starts', async () => {
    const client = new FakeClient();
    const original = client.request.bind(client);
    client.request = async (path, options): Promise<unknown> => {
      if (path === '/marketplace/partner/payment')
        throw new TypeError('connection lost after send');
      return original(path, options);
    };
    await expect(record(client, directory).handler(payment)).rejects.toThrow('connection lost');
    client.request = original;
    await expect(record(client, directory).handler(payment)).rejects.toThrow(/reconcil/i);
    expect(client.calls).toHaveLength(0);
    expect(await readdir(directory)).toHaveLength(1);
  });

  test('refunds use a durable natural key and still require confirmation and ownership', async () => {
    const client = new FakeClient();
    const refund = (): ReturnType<typeof buildTools>[number] =>
      buildTools({ ...testConfig, INTEGRATIONS_HUB_MCP_STATE_DIR: directory }, client).find(
        (tool) => tool.name === 'integrations_hub_refund_payment'
      )!;
    const input = {
      mode: 'apply',
      partner_id: 3,
      application_id: 7,
      payment_id: 123,
      confirmation: 'REFUND MARKETPLACE PAYMENT 123',
    };
    await expect(refund().handler({ ...input, confirmation: 'refund' })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
    expect(await readdir(directory)).toHaveLength(0);
    await refund().handler(input);
    await expect(refund().handler(input)).resolves.toMatchObject({
      applied: false,
      idempotent: true,
    });
    expect(client.calls).toHaveLength(1);
    client.applications = [];
    await expect(refund().handler(input)).rejects.toThrow('not owned');
  });

  test('serializes separate server instances and preserves a conflicting payload refusal', async () => {
    const client = new FakeClient();
    const results = await Promise.all([
      record(client, directory).handler(payment),
      record(client, directory).handler(payment),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ applied: true }),
        expect.objectContaining({ idempotent: true }),
      ])
    );
    expect(client.calls.filter(({ path }) => path === '/marketplace/partner/payment')).toHaveLength(
      1
    );
    await expect(
      record(client, directory).handler({ ...payment, payment_sum: 101 })
    ).rejects.toThrow('different payload');
  });

  test('plan and missing confirmation create no durable state or writes', async () => {
    const client = new FakeClient();
    const tool = record(client, directory);
    await tool.handler({ ...payment, mode: 'plan' });
    await expect(tool.handler({ ...payment, confirmation: undefined })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
    expect(await readdir(directory)).toHaveLength(0);
  });
});

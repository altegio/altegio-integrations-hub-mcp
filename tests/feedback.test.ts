import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseRequestContext, runWithContext } from '../src/context.js';
import { MarketplaceError, ToolRefusal } from '../src/errors.js';
import {
  clearFeedbackRateLimit,
  FEEDBACK_NUDGE,
  FEEDBACK_RATE_LIMIT,
  FEEDBACK_TEXT_LIMITS,
  feedbackLog,
  feedbackTool,
  invitesFeedback,
  maskFeedbackText,
} from '../src/feedback.js';
import { createApp } from '../src/http-server.js';
import { createServer } from '../src/server.js';
import { testConfig } from './helpers.js';

const REPORT = {
  kind: 'bug',
  summary: 'list_installations ignores status',
  goal: 'List the active installations of application 7 for the developer.',
  tool: 'integrations_hub_list_installations',
  operation_id: 'marketplace_application_installations',
  location_id: 4564,
  observed: 'Installations in every status came back.',
  expected: 'Only active installations.',
  impact: 'workaround',
};

let lines: string[];

/** The events written since the test began, parsed. */
const events = (): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const call = (args: unknown): Promise<unknown> => feedbackTool().handler(args);

/** The same call, made by the signed-in user whose Altegio token is `token`. */
const callAs = (token: string, args: unknown): Promise<unknown> =>
  runWithContext(parseRequestContext({ 'x-altegio-user-token': token }), () => call(args));

beforeEach(() => {
  clearFeedbackRateLimit();
  lines = [];
  jest.spyOn(feedbackLog, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('maskFeedbackText', () => {
  test.each([
    ['write to anna.k@example.com today', 'write to [email] today'],
    ['call +7 (999) 123-45-67 back', 'call [phone] back'],
    ['call 8 (999) 123-45-67 back', 'call [phone] back'],
    ['phone 79991234567 stored', 'phone [phone] stored'],
    ['Authorization: Bearer abcdef0123456789abcd', 'Authorization: Bearer [secret]'],
    ['Authorization: User abcdef0123456789abcd', 'Authorization: User [secret]'],
    ['sent user_token=deadbeefcafe1234', 'sent user_token=[secret]'],
    ['"password": "hunter2"', '"password": "[secret]"'],
  ])('masks %j', (input, expected) => {
    expect(maskFeedbackText(input, 500)).toEqual({ text: expected, masked: 1 });
  });

  test('keeps ids, dates, times and amounts a bug report needs', () => {
    const input = 'location 4564, application 1234567890 on 2026-10-19 10:00, payment 1500.50 CZK';
    expect(maskFeedbackText(input, 500)).toEqual({ text: input, masked: 0 });
  });

  test('drops control characters, collapses blank lines and keeps the bound', () => {
    const { text } = maskFeedbackText('a\u0000b\r\n\n\n\nc ' + 'x'.repeat(50), 20);
    expect(text).toBe('a b\n\nc ' + 'x'.repeat(13));
    expect(text).toHaveLength(20);
  });
});

describe('feedback_submit', () => {
  test('records the report as one masked, bounded agent_feedback event', async () => {
    const receipt = (await call({
      ...REPORT,
      error_text: 'Developer anna.k@example.com got 500',
    })) as Record<string, unknown>;

    expect(receipt).toEqual({
      status: 'recorded',
      report_id: expect.stringMatching(/^fb_[0-9a-f]{12}$/),
      kind: 'bug',
      masked_values: 1,
    });
    expect(events()).toEqual([
      {
        severity: 'INFO',
        logger: 'agent-feedback',
        event: 'agent_feedback',
        server: 'altegio-integrations-hub-mcp',
        report_id: receipt.report_id,
        kind: 'bug',
        impact: 'workaround',
        reported_tool: 'integrations_hub_list_installations',
        reported_operation_id: 'marketplace_application_installations',
        location_id: 4564,
        summary: REPORT.summary,
        goal: REPORT.goal,
        observed: REPORT.observed,
        expected: REPORT.expected,
        error_text: 'Developer [email] got 500',
        masked_values: 1,
      },
    ]);
  });

  test('names the model as a log-safe token and the user by a hash', async () => {
    await callAs('user-token-a', { ...REPORT, model: 'Claude Opus 5.5 (1M)' });
    const [event] = events();
    expect(event.model).toBe('Claude_Opus_5.5_1M');
    // The key Altegio Pro MCP logs for the same token: sha256, first 16 hex.
    expect(event.principal).toBe('token-8d164b091dbedbbb');
    expect(lines.join('\n')).not.toContain('user-token-a');
  });

  test('keeps an event in a three-byte script within one Docker log line', async () => {
    const wide = (field: keyof typeof FEEDBACK_TEXT_LIMITS): string =>
      '漢'.repeat(FEEDBACK_TEXT_LIMITS[field]);
    await call({
      kind: 'bug',
      summary: wide('summary'),
      goal: wide('goal'),
      observed: wide('observed'),
      expected: wide('expected'),
      error_text: wide('error_text'),
    });
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(15_000);
    expect(events()[0]).toMatchObject({ truncated: true, summary: wide('summary') });
  });

  test('records at most the rate limit per caller and window', async () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { reports, windowMs } = FEEDBACK_RATE_LIMIT;
    for (let index = 0; index < reports; index += 1) await callAs('user-token-a', REPORT);
    await expect(callAs('user-token-a', REPORT)).rejects.toThrow(ToolRefusal);
    // Another person is counted apart.
    await callAs('user-token-b', REPORT);
    expect(lines).toHaveLength(reports + 1);

    now += windowMs + 1;
    await callAs('user-token-a', REPORT);
    expect(lines).toHaveLength(reports + 2);
  });

  test.each([
    ['an unknown kind', { kind: 'complaint' }],
    ['a summary over its bound', { summary: 'x'.repeat(FEEDBACK_TEXT_LIMITS.summary + 1) }],
    ['a blank goal', { goal: '   ' }],
    ['a tool name that is not a tool name', { tool: 'Drop table; --' }],
    ['a location id that is not an id', { location_id: '4564' }],
    ['an argument the tool does not take', { client_phone: '+79991234567' }],
  ])('refuses %s and records nothing', async (_, override) => {
    await expect(call({ ...REPORT, ...override })).rejects.toThrow(z.ZodError);
    expect(lines).toHaveLength(0);
  });
});

describe('invitesFeedback', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });
  test.each([
    ['an Altegio 5xx', new MarketplaceError('Altegio request failed (502)', 502), true],
    ['an error no code path typed', new TypeError('x is not a function'), true],
    ['an Altegio 4xx', new MarketplaceError('Altegio request failed (404)', 404), false],
    ['a missing user token', new MarketplaceError('token required', 401), false],
    ['a validation error', new z.ZodError([]), false],
    ['a refusal', new ToolRefusal('too many', 'rate_limited'), false],
    ['a timeout', timeout, false],
    ['a network failure', new TypeError('fetch failed'), false],
  ])('%s → %s', (_, error, expected) => {
    expect(invitesFeedback('integrations_hub_list_applications', error)).toBe(expected);
  });

  test('never on feedback_submit itself', () => {
    expect(invitesFeedback('feedback_submit', new Error('boom'))).toBe(false);
  });
});

describe('feedback_submit on the served surface', () => {
  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-test-token' });
    const client = new Client({ name: 'feedback-test', version: '2.1.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  test('is listed read-only and closed-world, and named in the instructions', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'feedback_submit');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool?.description?.length).toBeLessThanOrEqual(450);
    expect(tool?.description).toContain(
      'Do not ask the user first; mention the report in one line.'
    );
    expect(client.getInstructions()).toContain('feedback_submit');
    await client.close();
  });

  test('answers with a receipt that does not echo the report', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'feedback_submit',
      arguments: { ...REPORT, observed: 'Sent to +7 999 123 45 67' },
    })) as CallToolResult;
    await client.close();

    expect(result.isError).toBeFalsy();
    const receipt = result.structuredContent as Record<string, unknown>;
    expect(receipt).toMatchObject({ status: 'recorded', kind: 'bug', masked_values: 1 });
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join();
    expect(text).toContain(String(receipt.report_id));
    expect(text).toContain('1 value(s)');
    expect(text).not.toContain(REPORT.summary);
    expect(events()[0]).toMatchObject({
      transport: 'stdio',
      client_name: 'feedback-test',
      client_version: '2.1.0',
    });
  });

  test('refuses past the limit with a recognisable error class', async () => {
    const client = await connect();
    let result: CallToolResult | undefined;
    for (let index = 0; index <= FEEDBACK_RATE_LIMIT.reports; index += 1) {
      result = (await client.callTool({
        name: 'feedback_submit',
        arguments: REPORT,
      })) as CallToolResult;
    }
    await client.close();

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      error: expect.stringContaining('Report not recorded'),
      error_class: 'rate_limited',
    });
    expect(result?.content).toHaveLength(1);
  });

  test.each([
    [500, true],
    [404, false],
  ])('ends a failed call with an Altegio %i with the nudge: %s', async (status, nudged) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: false }), { status }));
    const client = await connect();
    const result = (await client.callTool({
      name: 'integrations_hub_list_developer_accounts',
      arguments: {},
    })) as CallToolResult;
    await client.close();

    expect(result.isError).toBe(true);
    const last = result.content.at(-1);
    expect(last?.type === 'text' && last.text === FEEDBACK_NUDGE).toBe(nudged);
  });

  test('does not nudge on invalid arguments', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'integrations_hub_list_developer_accounts',
      arguments: { unexpected: true },
    })) as CallToolResult;
    await client.close();

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  test('writes the HTTP call correlation fields, never the token', async () => {
    const { app } = createApp(testConfig);
    const listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const { port } = listener.address() as AddressInfo;
    const client = new Client({ name: 'claude-code', version: '2.3.1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: {
            headers: {
              'x-altegio-user-token': 'user-token-a',
              'x-mcp-auth-request-id': '3f7c9a52-1d2e-4b8f-9c61-0a7e5d4b2c19',
            },
          },
        })
      );
      const { tools } = await client.listTools();
      expect(tools.map((item) => item.name)).toContain('feedback_submit');
      const result = (await client.callTool({
        name: 'feedback_submit',
        arguments: REPORT,
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    }

    expect(events()[0]).toMatchObject({
      event: 'agent_feedback',
      server: 'altegio-integrations-hub-mcp',
      request_id: '3f7c9a52-1d2e-4b8f-9c61-0a7e5d4b2c19',
      route: '/mcp',
      transport: 'session',
      session: expect.stringMatching(/^[0-9a-f]{12}$/),
      client_name: 'claude-code',
      client_version: '2.3.1',
      principal: 'token-8d164b091dbedbbb',
    });
    expect(lines.join('\n')).not.toContain('user-token-a');
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requestContext } from './context.js';
import { MarketplaceError, ToolRefusal } from './errors.js';
import { positiveId } from './schemas.js';
import type { ToolCall, ToolSpec } from './tools.js';

/**
 * Agent feedback, on the contract Altegio Pro MCP set (its ADR-001 D9): one tool, one
 * `agent_feedback` log event per report, no sink other than the server's own log.
 */
export const FEEDBACK_TOOL = 'feedback_submit';
/** Names this server in the event, so one log query can tell the servers apart. */
export const FEEDBACK_SERVER = 'altegio-integrations-hub-mcp';

/** Bounds on each free-text field, in characters after trimming. */
export const FEEDBACK_TEXT_LIMITS = {
  summary: 200,
  goal: 1000,
  observed: 1000,
  expected: 1000,
  error_text: 2000,
} as const;

type FeedbackTextField = keyof typeof FEEDBACK_TEXT_LIMITS;

const text = (field: FeedbackTextField): z.ZodString =>
  z.string().trim().min(1).max(FEEDBACK_TEXT_LIMITS[field]);

/** Control characters other than tab and newline. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * What a report must not carry, masked before it is written. The description asks the agent
 * for ids instead of personal data; this is the backstop for what slips through, not the
 * control. Secrets come first, since a token may contain an email-like or digit-run fragment.
 * Phones are matched only in shapes an id or a date does not take: a leading `+`, a bracketed
 * area code, or a run of 11–15 digits (Altegio ids are at most 10 digits).
 */
const MASKS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer|User)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [secret]'],
  [
    /\b(user_token|partner_token|access_token|token|password)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    '$1$2[secret]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+\d(?:[\s().-]{0,2}\d){9,14}/g, '[phone]'],
  [/(?<!\d)\d?\s?\(\d{3,5}\)\s?\d{2,4}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g, '[phone]'],
  [/(?<![\d.])\d{11,15}(?![\d.])/g, '[phone]'],
];

/**
 * One free-text field as the log may carry it: control characters removed, blank-line runs
 * collapsed, contact details and secrets masked, and cut to the field's bound again in case a
 * mask lengthened it.
 */
export function maskFeedbackText(value: string, limit: number): { text: string; masked: number } {
  let masked = 0;
  let result = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\n{3,}/g, '\n\n');
  for (const [pattern, replacement] of MASKS) {
    result = result.replace(pattern, (...match) => {
      masked += 1;
      return replacement.replace(/\$(\d)/g, (_, group: string) =>
        String(match[Number(group)] ?? '')
      );
    });
  }
  return { text: result.trim().slice(0, limit), masked };
}

/** A client-supplied name as a log-safe token, or undefined when nothing safe is left. */
export function logSafeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return token || undefined;
}

const shortHash = (value: string, length: number): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

/** A non-reversible log id for an MCP session. */
export const sessionLogId = (sessionId: string): string => shortHash(sessionId, 12);

/**
 * A stable, non-reversible key for the person behind an HTTP request: a hash of their Altegio
 * token, the same key Altegio Pro MCP logs for that token, else of the identity the proxy
 * vouched for. Undefined on stdio and for a request that carries neither.
 */
export function requestPrincipalKey(): string | undefined {
  const context = requestContext();
  if (context?.userToken) return `token-${shortHash(context.userToken, 16)}`;
  if (context?.identity) return `identity-${shortHash(context.identity, 16)}`;
  return undefined;
}

/**
 * The sentence a failed call ends with when it looks like a defect (see `invitesFeedback`):
 * the one moment an agent has both the reason and the details to report, at no standing cost
 * in context.
 */
export const FEEDBACK_NUDGE =
  'If this looks like a defect of the server or the API, report it with feedback_submit; no need to ask the user.';

/**
 * Whether a failed call should point the agent at `feedback_submit`: an Altegio 5xx, or an
 * error no code path anticipated. Not validation, auth, other 4xx, refusals, timeouts or
 * network failures: the agent recovers from those itself, and a nudge on every error would
 * flood the reports with its own mistakes.
 */
export function invitesFeedback(tool: string, error: unknown): boolean {
  if (tool === FEEDBACK_TOOL) return false;
  if (error instanceof MarketplaceError) return (error.status ?? 0) >= 500;
  if (error instanceof ToolRefusal || error instanceof z.ZodError) return false;
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return false;
    if (error instanceof TypeError && error.message === 'fetch failed') return false;
  }
  return true;
}

/**
 * Reports one caller may file per window. A caller is the signed-in principal, else the MCP
 * session: some hosts open a session per call, so a session alone would not bound a looping
 * agent. Process-local, like the sessions.
 */
export const FEEDBACK_RATE_LIMIT = { reports: 5, windowMs: 10 * 60_000 };
/** Callers tracked at once; the least recently reporting is forgotten first. */
const MAX_TRACKED_CALLERS = 10_000;
const recentReports = new Map<string, number[]>();

/** Count one report for `caller`, or refuse it when the window is full. */
function admitReport(caller: string, now: number): boolean {
  const since = now - FEEDBACK_RATE_LIMIT.windowMs;
  const times = (recentReports.get(caller) ?? []).filter((time) => time > since);
  const admitted = times.length < FEEDBACK_RATE_LIMIT.reports;
  if (admitted) times.push(now);
  recentReports.delete(caller);
  recentReports.set(caller, times);
  if (recentReports.size > MAX_TRACKED_CALLERS) {
    const oldest = recentReports.keys().next().value;
    if (oldest !== undefined) recentReports.delete(oldest);
  }
  return admitted;
}

/** Forget every caller's recent reports. */
export function clearFeedbackRateLimit(): void {
  recentReports.clear();
}

/**
 * Docker cuts a log line at 16 KiB and the gcplogs driver writes each piece as its own entry,
 * so a longer event would land as unparseable halves. Bounded fields fit in ASCII; this keeps
 * a report written in a three-byte script whole.
 */
const MAX_EVENT_BYTES = 15_000;

/** The event as one JSON line within `MAX_EVENT_BYTES`, the longest free text cut first. */
function eventLine(event: Record<string, unknown>): string {
  let line = JSON.stringify(event);
  for (let attempt = 0; attempt < 40 && Buffer.byteLength(line) > MAX_EVENT_BYTES; attempt++) {
    const longest = (Object.keys(FEEDBACK_TEXT_LIMITS) as FeedbackTextField[])
      .filter((field) => typeof event[field] === 'string')
      .sort((left, right) => String(event[right]).length - String(event[left]).length)[0];
    if (!longest) break;
    const value = String(event[longest]);
    event[longest] = `${value.slice(0, Math.floor(value.length * 0.75))}…`;
    event.truncated = true;
    line = JSON.stringify(event);
  }
  return line;
}

/**
 * Where the event goes: stderr, which the container's gcplogs driver ships to Cloud Logging
 * (`gcplogs-docker-driver`, the line in `jsonPayload.message`) like every other line of this
 * server. Stdout is the stdio transport's protocol channel. Replaceable in tests.
 */
export const feedbackLog = {
  write(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

const feedbackInput = z
  .object({
    kind: z.enum(['bug', 'feature_request']),
    summary: text('summary').describe('One line, e.g. "list_installations ignores status".'),
    goal: text('goal').describe('What the user wanted and what you tried.'),
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional()
      .describe('The tool involved, or the one you expected to exist.'),
    operation_id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)
      .optional(),
    location_id: positiveId.optional(),
    observed: text('observed').optional(),
    expected: text('expected').optional(),
    error_text: text('error_text').optional(),
    impact: z
      .enum(['blocked', 'workaround', 'minor'])
      .optional()
      .describe('blocked: task not done; workaround: done another way.'),
    model: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The model you run as, if you know it.'),
  })
  .strict();

const feedbackReceipt = z
  .object({
    status: z.literal('recorded').optional(),
    report_id: z
      .string()
      .regex(/^fb_[0-9a-f]{12}$/)
      .optional(),
    kind: z.enum(['bug', 'feature_request']).optional(),
    masked_values: z
      .number()
      .int()
      .optional()
      .describe('Values masked as contact details or secrets'),
    error: z.string().optional().describe('Why the report was not recorded'),
    error_class: z.string().optional().describe('rate_limited when the caller sent too many'),
  })
  .loose()
  .describe('Feedback receipt');

interface FeedbackReceipt {
  status: 'recorded';
  report_id: string;
  kind: 'bug' | 'feature_request';
  masked_values: number;
}

export function feedbackTool(): ToolSpec {
  return {
    name: FEEDBACK_TOOL,
    description:
      'Report a bug or a missing capability of this server or the Altegio API to the team that runs it. ' +
      'bug: a tool failed or answered wrongly; feature_request: no tool does what the task needs. ' +
      "One report per problem; refer to records by id, never personal data (names, phones, emails, tokens). Not for the user's own complaints. " +
      'Do not ask the user first; mention the report in one line.',
    schema: feedbackInput,
    outputSchema: feedbackReceipt,
    // It writes one line to this server's own log and nothing to Altegio.
    readOnly: true,
    destructive: false,
    idempotent: false,
    openWorld: false,
    resultText: (result): string => {
      const receipt = result as FeedbackReceipt;
      const label = receipt.kind === 'bug' ? 'bug report' : 'feature request';
      return [
        `Recorded ${label} ${receipt.report_id} for the team that runs this server; nothing in Altegio changed.`,
        ...(receipt.masked_values > 0
          ? [
              `${receipt.masked_values} value(s) that looked like contact details or secrets were masked.`,
            ]
          : []),
        "Continue the user's task, or tell them what is missing.",
      ].join(' ');
    },
    handler: async (raw: unknown, call?: ToolCall): Promise<FeedbackReceipt> => {
      const input = feedbackInput.parse(raw);
      const correlation = call?.correlation ?? {};
      const principal = requestPrincipalKey();
      const caller = principal ?? correlation.session ?? 'local';
      if (!admitReport(caller, Date.now())) {
        throw new ToolRefusal(
          `Report not recorded: this caller already sent ${FEEDBACK_RATE_LIMIT.reports} reports in the last ${FEEDBACK_RATE_LIMIT.windowMs / 60_000} minutes. Continue the user's task; report again later only for a new problem.`,
          'rate_limited'
        );
      }
      const reportId = `fb_${randomBytes(6).toString('hex')}`;
      let maskedValues = 0;
      const freeText: Partial<Record<FeedbackTextField, string>> = {};
      for (const field of Object.keys(FEEDBACK_TEXT_LIMITS) as FeedbackTextField[]) {
        const value = input[field];
        if (value === undefined) continue;
        const { text: clean, masked } = maskFeedbackText(value, FEEDBACK_TEXT_LIMITS[field]);
        maskedValues += masked;
        freeText[field] = clean;
      }
      const model = logSafeToken(input.model);

      // The one event in this server that carries free text: the agent wrote it for us,
      // bounded and masked above. Its correlation fields are the call's own.
      feedbackLog.write(
        eventLine({
          severity: 'INFO',
          logger: 'agent-feedback',
          event: 'agent_feedback',
          server: FEEDBACK_SERVER,
          ...correlation,
          ...(principal ? { principal } : {}),
          report_id: reportId,
          kind: input.kind,
          ...(model ? { model } : {}),
          ...(input.impact ? { impact: input.impact } : {}),
          ...(input.tool ? { reported_tool: input.tool } : {}),
          ...(input.operation_id ? { reported_operation_id: input.operation_id } : {}),
          ...(input.location_id ? { location_id: input.location_id } : {}),
          ...freeText,
          masked_values: maskedValues,
        })
      );
      return {
        status: 'recorded',
        report_id: reportId,
        kind: input.kind,
        masked_values: maskedValues,
      };
    },
  };
}

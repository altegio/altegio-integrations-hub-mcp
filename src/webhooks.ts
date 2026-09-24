import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MarketplaceError } from './errors.js';
import { httpsUrl } from './schemas.js';

// Public tool vocabulary on the left; legacy /hooks_settings wire fields on the right.
export const eventFields = {
  location: 'salon',
  team_member: 'master',
  product: 'good',
  service: 'service',
  service_category: 'service_category',
  client: 'client',
  appointment: 'record',
  schedule: 'schedule',
  loyalty_card: 'loyalty_card',
  goods_sale: 'goods_operations_sale',
  goods_receipt: 'goods_operations_receipt',
  goods_consumption: 'goods_operations_consumable',
  goods_theft: 'goods_operations_stolen',
  goods_move: 'goods_operations_move',
  finance_operation: 'finances_operation',
} as const;

export type EventName = keyof typeof eventFields;
export const webhookEvents = z
  .object(
    Object.fromEntries(Object.keys(eventFields).map((key) => [key, z.boolean().optional()])) as {
      [K in EventName]: z.ZodOptional<z.ZodBoolean>;
    }
  )
  .strict();

export const webhookChange = z
  .object({
    action: z.enum(['add_destination', 'replace_destination', 'remove_destination', 'set_events']),
    url: z
      .string()
      .url()
      .max(4096)
      .optional()
      .describe('Destination to add, replace, or remove; new URLs must use HTTPS'),
    replacement_url: httpsUrl
      .max(4096)
      .optional()
      .describe('New destination for replace_destination'),
    active: z.boolean().optional().describe('Enable or disable all location event hooks'),
    events: webhookEvents
      .optional()
      .describe('Partial event selection; other visible flags are kept'),
    product: z
      .boolean()
      .optional()
      .describe('Product flag override when reading an older backend that omits good'),
    self_sending: z
      .boolean()
      .optional()
      .describe('Self-sending override when reading an older backend that omits it'),
    overwrite_shared_settings: z
      .boolean()
      .default(false)
      .describe('Acknowledge that upstream applies one event selection to all existing URLs'),
  })
  .strict();

export interface UrlHookSettings {
  url: string;
  active: boolean;
  events: Record<EventName, boolean>;
  self_sending: boolean;
}

export interface HookSettings {
  urls: string[];
  active: number;
  events: Record<EventName, boolean | null>;
  self_sending: boolean | null;
  url_settings: UrlHookSettings[] | null;
  snapshot: string;
  unreadable_fields: string[];
  note: string;
}

function bit(value: unknown, field: string): number {
  if (value === 1 || value === true) return 1;
  if (value === 0 || value === false) return 0;
  throw new MarketplaceError(`Upstream webhook settings omitted or invalidated ${field}.`, 502);
}

export function parseHookSettings(response: unknown): HookSettings {
  const envelope = response as Record<string, unknown> | null;
  const data = envelope?.data as Record<string, unknown> | undefined;
  if (
    !data ||
    !Array.isArray(data.urls) ||
    data.urls.some((url) => typeof url !== 'string' || url.length > 4096)
  ) {
    throw new MarketplaceError('Unexpected location webhook settings response.', 502);
  }
  const urls = (data.urls as string[]).filter((url) => url !== '');
  if (urls.length > 10)
    throw new MarketplaceError('Upstream returned over 10 webhook destinations.', 502);
  if (new Set(urls).size !== urls.length)
    throw new MarketplaceError('Upstream returned duplicate webhook destinations.', 502);
  const events = {} as Record<EventName, boolean | null>;
  const unreadable_fields: string[] = [];
  for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
    if (data[field] === undefined && (field === 'good' || field === 'schedule')) {
      events[name] = null;
      unreadable_fields.push(name);
    } else {
      events[name] = bit(data[field], field) === 1;
    }
  }
  const active = bit(data.active, 'active');
  const self_sending =
    data.self_sending === undefined ? null : bit(data.self_sending, 'self_sending') === 1;
  if (self_sending === null) unreadable_fields.push('self_sending');
  let url_settings: UrlHookSettings[] | null = null;
  if (data.url_settings === undefined) {
    unreadable_fields.push('per_url_flags');
  } else {
    if (!Array.isArray(data.url_settings))
      throw new MarketplaceError('Unexpected per-URL webhook settings response.', 502);
    url_settings = data.url_settings.map((item: unknown) => {
      const row = item as Record<string, unknown> | null;
      if (!row || typeof row.url !== 'string' || !urls.includes(row.url))
        throw new MarketplaceError('Unexpected webhook destination in per-URL settings.', 502);
      const rowEvents = {} as Record<EventName, boolean>;
      for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
        rowEvents[name] = bit(row[field], `url_settings.${field}`) === 1;
      }
      return {
        url: row.url,
        active: bit(row.active, 'url_settings.active') === 1,
        events: rowEvents,
        self_sending: bit(row.self_sending, 'url_settings.self_sending') === 1,
      };
    });
    if (
      url_settings.length !== urls.length ||
      new Set(url_settings.map((item) => item.url)).size !== urls.length
    ) {
      throw new MarketplaceError('Incomplete per-URL webhook settings response.', 502);
    }
  }
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        urls: [...urls].sort(),
        active,
        events,
        self_sending,
        url_settings: url_settings
          ? [...url_settings].sort((left, right) => left.url.localeCompare(right.url))
          : null,
      })
    )
    .digest('hex');
  return {
    urls,
    active,
    events,
    self_sending,
    url_settings,
    snapshot,
    unreadable_fields,
    note:
      url_settings === null
        ? 'This backend does not expose per-destination flags. Top-level flags describe only the first destination.'
        : 'Top-level flags describe only the first destination; url_settings shows each destination. The API reports configuration, not delivery status.',
  };
}

export function planHookChange(
  current: HookSettings,
  change: z.infer<typeof webhookChange>
): Record<string, unknown> {
  const urls = [...current.urls];
  if (current.urls.length > 1 && !change.overwrite_shared_settings) {
    throw new MarketplaceError(
      'Multiple destinations will be rewritten with one event selection. Set overwrite_shared_settings=true to acknowledge this location-wide replacement.',
      409
    );
  }
  if (
    change.product !== undefined &&
    change.events?.product !== undefined &&
    change.events.product !== change.product
  ) {
    throw new MarketplaceError('events.product and product disagree.', 400);
  }
  if (current.events.schedule === null && change.events?.schedule === true)
    throw new MarketplaceError('The backend does not report schedule support yet.', 409);
  const index = change.url === undefined ? -1 : urls.indexOf(change.url);
  switch (change.action) {
    case 'add_destination':
      if (!change.url || change.replacement_url)
        throw new MarketplaceError('Provide url only.', 400);
      httpsUrl.parse(change.url);
      if (index >= 0) throw new MarketplaceError('Destination already exists.', 409);
      urls.push(change.url);
      break;
    case 'replace_destination':
      if (!change.url || !change.replacement_url || index < 0)
        throw new MarketplaceError('Provide an existing url and replacement_url.', 400);
      if (urls.includes(change.replacement_url))
        throw new MarketplaceError('Replacement destination already exists.', 409);
      urls[index] = change.replacement_url;
      break;
    case 'remove_destination':
      if (!change.url || change.replacement_url || index < 0)
        throw new MarketplaceError('Provide an existing url only.', 400);
      urls.splice(index, 1);
      break;
    case 'set_events':
      if (change.url || change.replacement_url || (!change.events && change.active === undefined))
        throw new MarketplaceError('Provide events or active, without a destination.', 400);
      break;
  }
  if (urls.length === 0)
    throw new MarketplaceError('The upstream API requires at least one destination.', 400);
  if (urls.length > 10)
    throw new MarketplaceError('The upstream API permits at most 10 destinations.', 400);
  const body: Record<string, unknown> = {
    urls,
    active: Number(change.active ?? Boolean(current.active)),
  };
  const selfSending = change.self_sending ?? current.self_sending;
  if (selfSending === null)
    throw new MarketplaceError('This backend omits self_sending; supply it explicitly.', 400);
  body.self_sending = Number(selfSending);
  for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
    const value =
      name === 'product'
        ? (change.events?.product ?? change.product ?? current.events.product)
        : (change.events?.[name] ?? current.events[name]);
    if (value === null) {
      if (name === 'schedule') {
        continue;
      }
      throw new MarketplaceError(`This backend omits ${name}; supply it explicitly.`, 400);
    }
    body[field] = Number(value);
  }
  return body;
}

export function hookSettingsMatchBody(
  settings: HookSettings,
  body: Record<string, unknown>
): boolean {
  if (
    JSON.stringify([...settings.urls].sort()) !==
      JSON.stringify([...(body.urls as string[])].sort()) ||
    settings.active !== body.active
  ) {
    return false;
  }
  for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
    if (settings.events[name] !== null && Number(settings.events[name]) !== body[field])
      return false;
  }
  if (settings.self_sending !== null && Number(settings.self_sending) !== body.self_sending)
    return false;
  for (const row of settings.url_settings ?? []) {
    if (Number(row.active) !== body.active || Number(row.self_sending) !== body.self_sending)
      return false;
    for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
      if (Number(row.events[name]) !== body[field]) return false;
    }
  }
  return true;
}

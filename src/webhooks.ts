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
    product: z.boolean().describe('Current or desired product flag; upstream GET omits this field'),
    self_sending: z
      .boolean()
      .describe('Current or desired self-sending choice; upstream GET omits it'),
    overwrite_shared_settings: z
      .boolean()
      .default(false)
      .describe('Acknowledge that upstream applies one event selection to all existing URLs'),
  })
  .strict();

const visibleFields = Object.values(eventFields).filter((field) => field !== 'good');

export interface HookSettings {
  urls: string[];
  active: number;
  events: Record<EventName, boolean | null>;
  snapshot: string;
  unreadable_fields: ['product', 'self_sending'];
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
  if (data.urls.length > 10)
    throw new MarketplaceError('Upstream returned over 10 webhook destinations.', 502);
  const events = {} as Record<EventName, boolean | null>;
  for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
    events[name] = field === 'good' ? null : bit(data[field], field) === 1;
  }
  const active = bit(data.active, 'active');
  const urls = data.urls as string[];
  const snapshot = createHash('sha256')
    .update(
      JSON.stringify({
        urls: [...urls].sort(),
        active,
        flags: visibleFields.map((field) => data[field]),
      })
    )
    .digest('hex');
  return {
    urls,
    active,
    events,
    snapshot,
    unreadable_fields: ['product', 'self_sending'],
    note: 'This location-wide read combines every destination. It does not reveal per-destination flags, product, or self-sending.',
  };
}

export function planHookChange(
  current: HookSettings,
  change: z.infer<typeof webhookChange>
): Record<string, unknown> {
  const urls = [...current.urls];
  if (current.urls.length > 1 && !change.overwrite_shared_settings) {
    throw new MarketplaceError(
      'Multiple destinations may have different hidden settings. Set overwrite_shared_settings=true to explicitly accept replacing their shared event selection.',
      409
    );
  }
  if (change.events?.product !== undefined && change.events.product !== change.product) {
    throw new MarketplaceError('events.product and product disagree.', 400);
  }
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
    self_sending: Number(change.self_sending),
  };
  for (const [name, field] of Object.entries(eventFields) as [EventName, string][]) {
    const value =
      name === 'product'
        ? (change.events?.product ?? change.product)
        : (change.events?.[name] ?? current.events[name]);
    body[field] = Number(value);
  }
  return body;
}

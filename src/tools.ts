import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { MarketplaceClient } from './client.js';
import { IdempotencyStore } from './idempotency.js';
import { MarketplaceError } from './errors.js';
import { planned, requireBackoffice, requireConfirmation } from './safety.js';
import {
  accountPayload,
  createAccountPayload,
  createApplicationPayload,
  date,
  dateTime,
  httpsUrl,
  installationSettings,
  mode,
  positiveId,
  specialOffer,
  updateApplicationPayload,
} from './schemas.js';

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  destructive: boolean;
  handler(input: unknown): Promise<unknown>;
}

function tool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<T>,
  annotations: { readOnly?: boolean; destructive?: boolean },
  handler: (input: z.infer<typeof schema>) => Promise<unknown>
): ToolSpec {
  return {
    name,
    description,
    schema,
    readOnly: annotations.readOnly ?? false,
    destructive: annotations.destructive ?? false,
    handler: async (input) => handler(schema.parse(input)),
  };
}

function bodyResult(operation: string, data: unknown): Record<string, unknown> {
  return { ok: true, applied: true, operation, data };
}

function pathPlan(
  operation: string,
  method: string,
  path: string,
  body?: unknown,
  warning?: string
): Record<string, unknown> {
  return planned({ operation, method, path, body, warning });
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function paymentSignature(
  token: string,
  payload: { salon_id: number; amount: number; discount: number | null }
): string {
  const parts = [`salon_id=${payload.salon_id}`, `amount=${payload.amount}`];
  if (payload.discount !== null) parts.push(`discount=${payload.discount}`);
  return createHmac('sha256', token).update(parts.join('&')).digest('hex');
}

export function buildTools(config: Config, client = new MarketplaceClient(config)): ToolSpec[] {
  const idempotency = new IdempotencyStore(config.MARKETPLACE_MCP_STATE_DIR);
  const owned = (partnerId: number, applicationId: number): Promise<void> =>
    client.assertOwnsApplication(partnerId, applicationId);
  const partnerRead = async (
    partnerId: number,
    applicationId: number,
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<unknown> => {
    await owned(partnerId, applicationId);
    const partnerToken = await client.partnerTokenForAccount(partnerId);
    return client.request(path, { lane: 'partner', host: 'app', query, partnerToken });
  };
  const partnerWrite = async (
    partnerId: number,
    applicationId: number,
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<unknown> => {
    await owned(partnerId, applicationId);
    const partnerToken = await client.partnerTokenForAccount(partnerId);
    return client.request(path, {
      method: 'POST',
      lane: 'partner',
      host: 'app',
      body,
      idempotencyKey,
      partnerToken,
    });
  };

  const partnerAndApp = {
    partner_id: positiveId.describe('Developer account ID used for caller ownership checks'),
    application_id: positiveId,
  };
  const mutation = { mode };

  return [
    tool(
      'marketplace_list_developer_accounts',
      'List developer accounts owned by the current Altegio user. Secret fields in partner-system metadata are redacted.',
      z.object({}).strict(),
      { readOnly: true },
      async () => client.request('/marketplace/developers/companies', { lane: 'user' })
    ),
    tool(
      'marketplace_create_developer_account',
      'Plan or create a developer account. Any partner token returned upstream is redacted from the tool response.',
      z.object({ ...mutation, account: createAccountPayload }).strict(),
      {},
      async ({ mode: applyMode, account }) => {
        const path = '/marketplace/developers/companies';
        if (applyMode === 'plan')
          return pathPlan('create_developer_account', 'POST', path, account);
        return bodyResult(
          'create_developer_account',
          await client.request(path, { method: 'POST', lane: 'user', body: account })
        );
      }
    ),
    tool(
      'marketplace_update_developer_account',
      'Plan or replace developer-account details. Send the complete current account payload.',
      z.object({ ...mutation, partner_id: positiveId, account: accountPayload }).strict(),
      {},
      async ({ mode: applyMode, partner_id, account }) => {
        const path = `/marketplace/developers/companies/${partner_id}`;
        if (applyMode === 'plan') return pathPlan('update_developer_account', 'PUT', path, account);
        return bodyResult(
          'update_developer_account',
          await client.request(path, { method: 'PUT', lane: 'user', body: account })
        );
      }
    ),
    tool(
      'marketplace_delete_developer_account',
      'Delete a developer account. This is destructive and may orphan its management workflow.',
      z
        .object({ ...mutation, partner_id: positiveId, confirmation: z.string().optional() })
        .strict(),
      { destructive: true },
      async ({ mode: applyMode, partner_id, confirmation }) => {
        const path = `/marketplace/developers/companies/${partner_id}`;
        if (applyMode === 'plan')
          return pathPlan('delete_developer_account', 'DELETE', path, undefined, 'Destructive');
        requireConfirmation(confirmation, `DELETE DEVELOPER ACCOUNT ${partner_id}`);
        return bodyResult(
          'delete_developer_account',
          await client.request(path, { method: 'DELETE', lane: 'user' })
        );
      }
    ),
    tool(
      'marketplace_list_applications',
      'List applications in a developer account, including card configuration, permissions, system-user ID, short links, and moderation state. Secret fields are redacted.',
      z.object({ partner_id: positiveId }).strict(),
      { readOnly: true },
      async ({ partner_id }) =>
        client.request(`/marketplace/developers/companies/${partner_id}/applications`, {
          lane: 'user',
        })
    ),
    tool(
      'marketplace_get_application',
      'Get one owned application by filtering the authoritative developer-account application list.',
      z.object(partnerAndApp).strict(),
      { readOnly: true },
      async ({ partner_id, application_id }) => {
        const applications = await client.ownedApplications(partner_id);
        const application = applications.find((item) => Number(item.id) === application_id);
        if (!application)
          throw new MarketplaceError(
            `Application ${application_id} not found in developer account ${partner_id}.`,
            404
          );
        return application;
      }
    ),
    tool(
      'marketplace_get_catalog_metadata',
      'Get current Marketplace categories, channels, and functionalities from Biz.ERP. Country IDs remain application/account fields; there is no Marketplace-specific country dictionary endpoint.',
      z.object({}).strict(),
      { readOnly: true },
      async () => {
        const [categories, channels, functionalities] = await Promise.all([
          client.request('/marketplace/applications/categories', { lane: 'public' }),
          client.request('/marketplace/applications/channels', { lane: 'public' }),
          client.request('/marketplace/applications/functionalities', { lane: 'public' }),
        ]);
        return { categories, channels, functionalities };
      }
    ),
    tool(
      'marketplace_list_available_rights',
      'Return the current hierarchical permission dictionary available to Marketplace system users.',
      z.object({ partner_id: positiveId }).strict(),
      { readOnly: true },
      async ({ partner_id }) =>
        client.request(
          `/marketplace/developers/companies/${partner_id}/applications/available_rights`,
          { lane: 'user' }
        )
    ),
    tool(
      'marketplace_create_application',
      'Plan or create a draft Marketplace application. Creation is naturally idempotent by slug within the developer account.',
      z
        .object({ ...mutation, partner_id: positiveId, application: createApplicationPayload })
        .strict(),
      {},
      async ({ mode: applyMode, partner_id, application }) => {
        const path = `/marketplace/developers/companies/${partner_id}/applications`;
        if (applyMode === 'plan') return pathPlan('create_application', 'POST', path, application);
        const existing = (await client.ownedApplications(partner_id)).find(
          (item) => item.slug === application.slug
        );
        if (existing)
          return {
            ok: true,
            applied: false,
            idempotent: true,
            operation: 'create_application',
            data: existing,
          };
        return bodyResult(
          'create_application',
          await client.request(path, { method: 'POST', lane: 'user', body: application })
        );
      }
    ),
    tool(
      'marketplace_update_application',
      'Plan or update the complete Marketplace card and technical settings: descriptions, media, countries, permissions, callbacks, iframe, multi-location, privacy, channels, and monetization.',
      z.object({ ...mutation, ...partnerAndApp, application: updateApplicationPayload }).strict(),
      {},
      async ({ mode: applyMode, partner_id, application_id, application }) => {
        await owned(partner_id, application_id);
        const path = `/marketplace/developers/companies/${partner_id}/applications/${application_id}`;
        if (applyMode === 'plan') return pathPlan('update_application', 'PUT', path, application);
        return bodyResult(
          'update_application',
          await client.request(path, { method: 'PUT', lane: 'user', body: application })
        );
      }
    ),
    tool(
      'marketplace_save_moderation_instructions',
      'Plan or save connection and payment instructions before submitting an application for moderation.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          connect_instruction: z.string().max(1000),
          payment_instruction: z.string().max(1000),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        connect_instruction,
        payment_instruction,
      }) => {
        await owned(partner_id, application_id);
        const path = `/marketplace/developers/companies/${partner_id}/applications/${application_id}/moderation`;
        const body = { connect_instruction, payment_instruction };
        if (applyMode === 'plan')
          return pathPlan('save_moderation_instructions', 'PUT', path, body);
        return bodyResult(
          'save_moderation_instructions',
          await client.request(path, { method: 'PUT', lane: 'user', body })
        );
      }
    ),
    tool(
      'marketplace_submit_for_moderation',
      'Plan or submit a fully configured application for Marketplace moderation.',
      z.object({ ...mutation, ...partnerAndApp, confirmation: z.string().optional() }).strict(),
      {},
      async ({ mode: applyMode, partner_id, application_id, confirmation }) => {
        await owned(partner_id, application_id);
        const path = `/marketplace/developers/companies/${partner_id}/applications/${application_id}/moderation/start`;
        if (applyMode === 'plan') return pathPlan('submit_for_moderation', 'POST', path);
        requireConfirmation(confirmation, `SUBMIT APPLICATION ${application_id} FOR MODERATION`);
        return bodyResult(
          'submit_for_moderation',
          await client.request(path, { method: 'POST', lane: 'user' })
        );
      }
    ),
    tool(
      'marketplace_list_entity_frames',
      'List declared employee/client/visit iframe definitions. Runtime use is currently gated in Biz.ERP.',
      z.object(partnerAndApp).strict(),
      { readOnly: true },
      async ({ partner_id, application_id }) => {
        await owned(partner_id, application_id);
        return client.request(
          `/marketplace/developers/companies/${partner_id}/applications/${application_id}/frames`,
          { lane: 'user' }
        );
      }
    ),
    tool(
      'marketplace_replace_entity_frames',
      'Plan or replace the full employee/client/visit frame declaration set. Omitted frames are deleted; runtime exposure remains feature-gated.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          frames: z
            .array(
              z
                .object({
                  title: z.string().min(3).max(100),
                  url: httpsUrl,
                  slug: z.enum(['employee', 'client', 'visit']),
                })
                .strict()
            )
            .max(7),
          confirmation: z.string().optional(),
        })
        .strict(),
      { destructive: true },
      async ({ mode: applyMode, partner_id, application_id, frames, confirmation }) => {
        await owned(partner_id, application_id);
        const path = `/marketplace/developers/companies/${partner_id}/applications/${application_id}/frames`;
        const body = { frames };
        if (applyMode === 'plan')
          return pathPlan(
            'replace_entity_frames',
            'POST',
            path,
            body,
            'Full replacement; omitted declarations are deleted.'
          );
        requireConfirmation(confirmation, `REPLACE FRAMES FOR APPLICATION ${application_id}`);
        return bodyResult(
          'replace_entity_frames',
          await client.request(path, { method: 'POST', lane: 'user', body })
        );
      }
    ),
    tool(
      'marketplace_grant_location_access',
      'Plan or perform step 1 of installation: location owner grants access, producing pending (or immediate active for eligible draft/private apps).',
      z.object({ ...mutation, ...partnerAndApp, location_id: positiveId }).strict(),
      {},
      async ({ mode: applyMode, partner_id, application_id, location_id }) => {
        await owned(partner_id, application_id);
        const path = `/company/${location_id}/marketplace/applications/${application_id}/grant_access`;
        if (applyMode === 'plan') return pathPlan('grant_location_access', 'POST', path);
        return bodyResult(
          'grant_location_access',
          await client.request(path, { method: 'POST', lane: 'user' })
        );
      }
    ),
    tool(
      'marketplace_activate_installation',
      'Plan or perform step 2: activate a pending installation and configure entity webhooks/chat/tips/channels. Active state is treated idempotently.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          settings: installationSettings,
        })
        .strict(),
      {},
      async ({ mode: applyMode, partner_id, application_id, location_id, settings }) => {
        const path = '/marketplace/partner/callback';
        const body = { salon_id: location_id, application_id, ...settings };
        if (applyMode === 'plan') return pathPlan('activate_installation', 'POST', path, body);
        const status = await partnerRead(
          partner_id,
          application_id,
          `/marketplace/salon/${location_id}/application/${application_id}`
        ).catch(() => undefined);
        if (JSON.stringify(status).includes('"status":"active"'))
          return {
            ok: true,
            applied: false,
            idempotent: true,
            operation: 'activate_installation',
            data: status,
          };
        return bodyResult(
          'activate_installation',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_get_installation_status',
      'Get status, payments, and status-transition log for an owned application at one location.',
      z.object({ ...partnerAndApp, location_id: positiveId }).strict(),
      { readOnly: true },
      async ({ partner_id, application_id, location_id }) =>
        partnerRead(
          partner_id,
          application_id,
          `/marketplace/salon/${location_id}/application/${application_id}`
        )
    ),
    tool(
      'marketplace_list_installations',
      'List locations connected to an owned application, with bounded pagination.',
      z
        .object({
          ...partnerAndApp,
          page: z.number().int().positive().default(1),
          count: z.number().int().min(1).max(1000).default(100),
        })
        .strict(),
      { readOnly: true },
      async ({ partner_id, application_id, page, count }) =>
        partnerRead(
          partner_id,
          application_id,
          `/marketplace/application/${application_id}/salons`,
          { page, count }
        )
    ),
    tool(
      'marketplace_uninstall',
      'Plan or uninstall an application from a location. Requires an exact confirmation phrase.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          confirmation: z.string().optional(),
        })
        .strict(),
      { destructive: true },
      async ({ mode: applyMode, partner_id, application_id, location_id, confirmation }) => {
        const path = `/marketplace/salon/${location_id}/application/${application_id}/uninstall`;
        if (applyMode === 'plan')
          return pathPlan(
            'uninstall',
            'POST',
            path,
            undefined,
            'Stops the integration and emits uninstall lifecycle events.'
          );
        requireConfirmation(
          confirmation,
          `UNINSTALL APPLICATION ${application_id} FROM LOCATION ${location_id}`
        );
        return bodyResult('uninstall', await partnerWrite(partner_id, application_id, path));
      }
    ),
    tool(
      'marketplace_notify_chat_message',
      'Signal a new chat message so Biz.ERP highlights the chat frame and may create notifications/leads according to location settings.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          phone_from: z.string().regex(/^\d+$/),
          message: z.string().max(4000),
          name: z.string().min(1).max(255),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        location_id,
        phone_from,
        message,
        name,
      }) => {
        const path = '/marketplace/application/new_message';
        const body = { salon_id: location_id, application_id, phone_from, message, name };
        if (applyMode === 'plan') return pathPlan('notify_chat_message', 'POST', path, body);
        return bodyResult(
          'notify_chat_message',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_install_sidebar_frame',
      'Attempt an allowlisted sidebar frame installation. Chat is normally configured through activation; waiting_list/task_tracker are product-gated.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          type: z.enum(['chat', 'waiting_list', 'task_tracker']),
          url: httpsUrl.nullable(),
          confirmation: z.string().optional(),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        location_id,
        type,
        url,
        confirmation,
      }) => {
        const path = '/marketplace/application/install_frame';
        const body = { salon_id: location_id, application_id, type, url };
        if (applyMode === 'plan')
          return pathPlan(
            'install_sidebar_frame',
            'POST',
            path,
            body,
            'The API enforces application allowlists and brand/runtime gates.'
          );
        requireConfirmation(
          confirmation,
          `INSTALL ${type} FRAME FOR APPLICATION ${application_id} AT LOCATION ${location_id}`
        );
        return bodyResult(
          'install_sidebar_frame',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_toggle_sidebar_highlight',
      'Enable or clear the highlight on an already installed sidebar frame, optionally for one user.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          type: z.enum(['chat', 'waiting_list', 'task_tracker']),
          user_id: positiveId.nullable().optional(),
          is_enabled: z.boolean(),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        location_id,
        type,
        user_id,
        is_enabled,
      }) => {
        const path = '/marketplace/application/toggle_highlight';
        const body = {
          salon_id: location_id,
          application_id,
          type,
          user_id: user_id ?? null,
          is_enabled,
        };
        if (applyMode === 'plan') return pathPlan('toggle_sidebar_highlight', 'POST', path, body);
        return bodyResult(
          'toggle_sidebar_highlight',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_list_tariffs',
      'List Marketplace billing tariffs and options for an owned application.',
      z.object(partnerAndApp).strict(),
      { readOnly: true },
      async ({ partner_id, application_id }) =>
        partnerRead(
          partner_id,
          application_id,
          `/marketplace/application/${application_id}/tariffs`
        )
    ),
    tool(
      'marketplace_get_payment_link',
      'Generate an Altegio-hosted Marketplace payment link for an installed location.',
      z
        .object({
          ...partnerAndApp,
          location_id: positiveId,
          tariff_option_id: positiveId,
          discount: z.number().min(0).max(100).default(0),
        })
        .strict(),
      { readOnly: true },
      async ({ partner_id, application_id, location_id, tariff_option_id, discount }) =>
        partnerRead(partner_id, application_id, '/marketplace/application/payment_link', {
          salon_id: location_id,
          application_id,
          tariff_option_id,
          discount,
        })
    ),
    tool(
      'marketplace_record_payment',
      'Plan or record a successful external payment. This can unfreeze an installation. Requires a durable idempotency key and exact confirmation.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          currency_iso: z
            .string()
            .length(3)
            .regex(/^[A-Z]{3}$/),
          payment_sum: z.number().nonnegative(),
          payment_date: dateTime,
          period_from: dateTime,
          period_to: dateTime,
          idempotency_key: z.string().min(8).max(200),
          confirmation: z.string().optional(),
        })
        .strict(),
      {},
      async (input) => {
        const body = {
          salon_id: input.location_id,
          application_id: input.application_id,
          currency_iso: input.currency_iso,
          payment_sum: input.payment_sum,
          payment_date: input.payment_date,
          period_from: input.period_from,
          period_to: input.period_to,
        };
        const path = '/marketplace/partner/payment';
        if (input.mode === 'plan')
          return pathPlan('record_payment', 'POST', path, body, 'May unfreeze the installation.');
        requireConfirmation(
          input.confirmation,
          `RECORD PAYMENT FOR APPLICATION ${input.application_id} AT LOCATION ${input.location_id}`
        );
        const fingerprint = idempotency.fingerprint(body);
        return idempotency.withLock(input.idempotency_key, async () => {
          const previous = await idempotency.get(input.idempotency_key, fingerprint);
          if (previous !== undefined)
            return {
              ok: true,
              applied: false,
              idempotent: true,
              operation: 'record_payment',
              data: previous,
            };
          const result = await partnerWrite(
            input.partner_id,
            input.application_id,
            path,
            body,
            input.idempotency_key
          );
          await idempotency.put(input.idempotency_key, fingerprint, result);
          return bodyResult('record_payment', result);
        });
      }
    ),
    tool(
      'marketplace_refund_payment',
      'Plan or report a Marketplace payment refund. Requires an exact confirmation phrase.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          payment_id: positiveId,
          confirmation: z.string().optional(),
        })
        .strict(),
      { destructive: true },
      async ({ mode: applyMode, partner_id, application_id, payment_id, confirmation }) => {
        const path = `/marketplace/partner/payment/refund/${payment_id}`;
        if (applyMode === 'plan')
          return pathPlan('refund_payment', 'POST', path, undefined, 'Financial action');
        requireConfirmation(confirmation, `REFUND MARKETPLACE PAYMENT ${payment_id}`);
        return bodyResult('refund_payment', await partnerWrite(partner_id, application_id, path));
      }
    ),
    tool(
      'marketplace_set_discount',
      'Plan or set the Marketplace payment discount for selected locations.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_ids: z.array(positiveId).min(1).max(1000),
          discount: z.number().min(0).max(100),
          confirmation: z.string().optional(),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        location_ids,
        discount,
        confirmation,
      }) => {
        const path = '/marketplace/application/add_discount';
        const body = { salon_ids: location_ids, application_id, discount };
        if (applyMode === 'plan') return pathPlan('set_discount', 'POST', path, body);
        requireConfirmation(confirmation, `SET DISCOUNT FOR APPLICATION ${application_id}`);
        return bodyResult(
          'set_discount',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_update_notification_channel',
      'Plan or update SMS/WhatsApp channel availability for a compatible installed application.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          channel: z.enum(['sms', 'whatsapp']),
          is_available: z.boolean(),
        })
        .strict(),
      {},
      async ({
        mode: applyMode,
        partner_id,
        application_id,
        location_id,
        channel,
        is_available,
      }) => {
        const path = '/marketplace/application/update_channel';
        const body = { salon_id: location_id, application_id, channel_slug: channel, is_available };
        if (applyMode === 'plan')
          return pathPlan('update_notification_channel', 'POST', path, body);
        return bodyResult(
          'update_notification_channel',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_set_sms_sender_names',
      'Plan or publish 1-20 SMS sender names for a compatible installed application.',
      z
        .object({
          ...mutation,
          ...partnerAndApp,
          location_id: positiveId,
          short_names: z
            .array(
              z
                .string()
                .min(1)
                .regex(/^(?!.*altegio)(?!ag$)[^А-Яа-я]+$/i)
            )
            .min(1)
            .max(20),
        })
        .strict(),
      {},
      async ({ mode: applyMode, partner_id, application_id, location_id, short_names }) => {
        const path = '/marketplace/partner/short_names';
        const body = { salon_id: location_id, application_id, short_names };
        if (applyMode === 'plan') return pathPlan('set_sms_sender_names', 'POST', path, body);
        return bodyResult(
          'set_sms_sender_names',
          await partnerWrite(partner_id, application_id, path, body)
        );
      }
    ),
    tool(
      'marketplace_get_statistics',
      'Get owned-application views, pending grants, activations, new payments, and uninstalls for a date range.',
      z.object({ ...partnerAndApp, date_from: date, date_to: date }).strict(),
      { readOnly: true },
      async ({ partner_id, application_id, date_from, date_to }) => {
        await owned(partner_id, application_id);
        return client.request(
          `/marketplace/developers/companies/${partner_id}/applications/main_stats`,
          { lane: 'user', query: { application_id, date_from, date_to } }
        );
      }
    ),
    tool(
      'marketplace_get_conversion_statistics',
      'Get application and category-average Marketplace funnel conversion series.',
      z
        .object({
          ...partnerAndApp,
          conversion: z.enum([
            'open_pending',
            'show_open',
            'active_payed',
            'pending_active',
            'pending_payed',
          ]),
          granularity: z.enum(['day', 'week', 'month']).default('day'),
          date_from: date,
          date_to: date,
        })
        .strict(),
      { readOnly: true },
      async ({ partner_id, application_id, conversion, granularity, date_from, date_to }) => {
        await owned(partner_id, application_id);
        return client.request(
          `/marketplace/developers/companies/${partner_id}/applications/conversion_stats`,
          {
            lane: 'user',
            query: { application_id, slug: conversion, granularity, date_from, date_to },
          }
        );
      }
    ),
    tool(
      'marketplace_list_reviews',
      'List public reviews for a Marketplace application.',
      z
        .object({ application_id: positiveId, page: z.number().int().positive().default(1) })
        .strict(),
      { readOnly: true },
      async ({ application_id, page }) =>
        client.request(`/marketplace/applications/${application_id}/reviews`, {
          lane: 'public',
          query: { page },
        })
    ),
    tool(
      'marketplace_validate_lifecycle_callback',
      'Validate and normalize an uninstall/freeze/payment callback payload against the owned developer-account token without revealing it.',
      z
        .object({
          partner_id: positiveId,
          payload: z.discriminatedUnion('event', [
            z
              .object({
                salon_id: positiveId,
                application_id: positiveId,
                event: z.enum(['uninstall', 'freeze']),
                partner_token: z.string().min(1),
              })
              .strict(),
            z
              .object({
                salon_id: positiveId,
                application_id: positiveId,
                event: z.literal('payment'),
                partner_token: z.string().min(1),
                payment_id: positiveId,
                amount: z.number().nonnegative(),
                currency_iso: z.string().length(3),
                discount: z.number().nullable(),
                period_from: z.unknown(),
                period_to: z.unknown(),
                payment_date: z.unknown(),
                tariff_option_id: positiveId.nullable(),
                sign: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          ]),
        })
        .strict(),
      { readOnly: true },
      async ({ partner_id, payload }) => {
        await owned(partner_id, payload.application_id);
        const partnerToken = await client.partnerTokenForAccount(partner_id);
        const tokenValid = constantTimeEqual(payload.partner_token, partnerToken);
        if (payload.event !== 'payment') {
          return {
            valid: tokenValid,
            token_valid: tokenValid,
            event: payload.event,
            location_id: payload.salon_id,
            application_id: payload.application_id,
          };
        }
        const signatureValid = constantTimeEqual(
          payload.sign,
          paymentSignature(partnerToken, payload)
        );
        return {
          valid: tokenValid && signatureValid,
          token_valid: tokenValid,
          signature_valid: signatureValid,
          event: payload.event,
          location_id: payload.salon_id,
          application_id: payload.application_id,
          payment: {
            payment_id: payload.payment_id,
            amount: payload.amount,
            currency_iso: payload.currency_iso,
            discount: payload.discount,
            period_from: payload.period_from,
            period_to: payload.period_to,
            payment_date: payload.payment_date,
            tariff_option_id: payload.tariff_option_id,
          },
        };
      }
    ),
    tool(
      'marketplace_backoffice_get_application',
      'Read internal Marketplace backoffice data. This is not a public API and is disabled by default.',
      z.object({ application_id: positiveId }).strict(),
      { readOnly: true },
      async ({ application_id }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        return client.request(`/marketplace/developers/backoffice/application/${application_id}`, {
          lane: 'admin',
        });
      }
    ),
    tool(
      'marketplace_backoffice_set_publication',
      'Plan or set/clear the internal moderated_at publication timestamp. Internal API; disabled by default.',
      z
        .object({
          ...mutation,
          application_id: positiveId,
          moderated_at: dateTime.nullable(),
          confirmation: z.string().optional(),
        })
        .strict(),
      {},
      async ({ mode: applyMode, application_id, moderated_at, confirmation }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        const path = `/marketplace/developers/backoffice/application/${application_id}/moderation`;
        const body = { moderated_at };
        if (applyMode === 'plan')
          return pathPlan(
            'backoffice_set_publication',
            'POST',
            path,
            body,
            'Internal production publication control.'
          );
        requireConfirmation(
          confirmation,
          `${moderated_at ? 'PUBLISH' : 'UNPUBLISH'} APPLICATION ${application_id}`
        );
        return bodyResult(
          'backoffice_set_publication',
          await client.request(path, { method: 'POST', lane: 'admin', body })
        );
      }
    ),
    tool(
      'marketplace_backoffice_set_commercials',
      'Plan or set internal commission/boost values. Internal API; disabled by default.',
      z
        .object({
          ...mutation,
          application_id: positiveId,
          commission: z.number().int().min(0).max(100).optional(),
          boost: z.number().finite().optional(),
          confirmation: z.string().optional(),
        })
        .strict()
        .refine(
          (value) => value.commission !== undefined || value.boost !== undefined,
          'commission or boost is required'
        ),
      {},
      async ({ mode: applyMode, application_id, commission, boost, confirmation }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        if (applyMode === 'plan')
          return pathPlan(
            'backoffice_set_commercials',
            'POST',
            `/marketplace/developers/backoffice/application/${application_id}/{commission|boost}`,
            { commission, boost },
            'Internal ranking/commercial control.'
          );
        requireConfirmation(confirmation, `SET COMMERCIALS FOR APPLICATION ${application_id}`);
        const results: unknown[] = [];
        if (commission !== undefined)
          results.push(
            await client.request(
              `/marketplace/developers/backoffice/application/${application_id}/commission`,
              { method: 'POST', lane: 'admin', body: { commission } }
            )
          );
        if (boost !== undefined)
          results.push(
            await client.request(
              `/marketplace/developers/backoffice/application/${application_id}/boost`,
              { method: 'POST', lane: 'admin', body: { boost } }
            )
          );
        return bodyResult('backoffice_set_commercials', results);
      }
    ),
    tool(
      'marketplace_backoffice_delete_application',
      'Delete an application and partner-linked entities through the internal backoffice API. Disabled by default and highly destructive.',
      z
        .object({ ...mutation, application_id: positiveId, confirmation: z.string().optional() })
        .strict(),
      { destructive: true },
      async ({ mode: applyMode, application_id, confirmation }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        const path = `/marketplace/developers/backoffice/application/${application_id}/delete`;
        if (applyMode === 'plan')
          return pathPlan(
            'backoffice_delete_application',
            'POST',
            path,
            undefined,
            'Deletes application and related partner entities.'
          );
        requireConfirmation(confirmation, `BACKOFFICE DELETE APPLICATION ${application_id}`);
        return bodyResult(
          'backoffice_delete_application',
          await client.request(path, { method: 'POST', lane: 'admin' })
        );
      }
    ),
    tool(
      'marketplace_backoffice_list_offers',
      'List internal Marketplace special offers. Internal API; disabled by default.',
      z.object({}).strict(),
      { readOnly: true },
      async () => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        return client.request('/marketplace/developers/backoffice/offers', { lane: 'admin' });
      }
    ),
    tool(
      'marketplace_backoffice_upsert_offer',
      'Plan or create/update an internal Marketplace special offer. Internal API; disabled by default.',
      z
        .object({
          ...mutation,
          offer_id: positiveId.optional(),
          offer: specialOffer,
          confirmation: z.string().optional(),
        })
        .strict(),
      {},
      async ({ mode: applyMode, offer_id, offer, confirmation }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        const path = offer_id
          ? `/marketplace/developers/backoffice/offers/${offer_id}`
          : '/marketplace/developers/backoffice/offers';
        const method = offer_id ? 'PUT' : 'POST';
        if (applyMode === 'plan') return pathPlan('backoffice_upsert_offer', method, path, offer);
        requireConfirmation(
          confirmation,
          `${offer_id ? 'UPDATE' : 'CREATE'} MARKETPLACE OFFER${offer_id ? ` ${offer_id}` : ''}`
        );
        return bodyResult(
          'backoffice_upsert_offer',
          await client.request(path, { method, lane: 'admin', body: offer })
        );
      }
    ),
    tool(
      'marketplace_backoffice_delete_offer',
      'Delete an internal Marketplace special offer. Internal API; disabled by default.',
      z.object({ ...mutation, offer_id: positiveId, confirmation: z.string().optional() }).strict(),
      { destructive: true },
      async ({ mode: applyMode, offer_id, confirmation }) => {
        requireBackoffice(config.ALLOW_BACKOFFICE, config.ALTEGIO_ADMIN_USER_TOKEN);
        const path = `/marketplace/developers/backoffice/offers/${offer_id}`;
        if (applyMode === 'plan')
          return pathPlan('backoffice_delete_offer', 'DELETE', path, undefined, 'Destructive');
        requireConfirmation(confirmation, `DELETE MARKETPLACE OFFER ${offer_id}`);
        return bodyResult(
          'backoffice_delete_offer',
          await client.request(path, { method: 'DELETE', lane: 'admin' })
        );
      }
    ),
  ];
}

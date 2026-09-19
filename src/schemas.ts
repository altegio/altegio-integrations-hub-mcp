import { z } from 'zod';

export const positiveId = z.number().int().positive().describe('Positive integer identifier');
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Calendar date in YYYY-MM-DD format');
export const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .describe('Local date and time in YYYY-MM-DD HH:mm:ss format');
export const mode = z
  .enum(['plan', 'apply'])
  .describe('Use plan to preview without writing; use apply to send the mutation');
export const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'HTTPS URL required',
  })
  .describe('Absolute HTTPS URL');

const baseAccount = {
  title: z.string().min(1).describe('Developer account display title'),
  description: z.string().min(1).describe('Developer or company description'),
  name: z.string().min(1).describe('Maintainer contact name'),
  phone: z.string().min(5).describe('Maintainer contact phone number'),
  email: z.string().email().describe('Maintainer contact email'),
  website_url: httpsUrl.describe('Developer or company website URL'),
  legal_type: z
    .enum(['llc', 'cjsc', 'jsc', 'ie', 'np', 'le'])
    .default('llc')
    .describe('Legal entity type expected by Developer Cabinet'),
};

export const createAccountPayload = z
  .object({
    ...baseAccount,
    partner_token: z
      .string()
      .min(1)
      .optional()
      .describe('Existing partner token to bind; treated as a secret and redacted'),
  })
  .strict();

export const accountPayload = z
  .object({
    ...baseAccount,
    country_id: positiveId.optional().describe('Country dictionary ID'),
    company_name: z.string().min(1).optional().describe('Registered company name'),
    reg_number: z.string().min(1).optional().describe('Company registration number'),
    privacy_policy_url: httpsUrl.optional().describe('Public privacy policy URL'),
  })
  .strict();

const baseApplication = {
  title: z.string().min(3).describe('Marketplace application title'),
  short_description: z.string().min(3).describe('Short catalogue-card description'),
  icon: z.string().nullable().optional().describe('Developer Cabinet icon value'),
  category_id: positiveId.describe('Marketplace category ID'),
  country_ids: z.array(positiveId).min(1).describe('Country IDs where the app is available'),
  website_url: z
    .union([httpsUrl, z.literal('')])
    .describe('Application website HTTPS URL, or an empty string'),
  price: z.string().describe('Human-readable catalogue price'),
  trial_duration: z.number().int().nonnegative().describe('Free trial duration in days'),
  channels: z.array(positiveId).describe('Marketplace channel dictionary IDs'),
  permissions: z
    .record(z.string().min(1), z.number().int())
    .describe(
      'Complete permission map keyed by current permission slug; includes flags, IDs, and numeric day limits such as -1 for unlimited history'
    ),
  callback_url: z
    .union([httpsUrl, z.literal('')])
    .default('')
    .describe('Backend URL for uninstall, freeze, and payment lifecycle callbacks'),
  registration_redirect_url: z
    .union([httpsUrl, z.literal('')])
    .default('')
    .describe('Application setup/settings URL opened after installation'),
  is_personal_data_access_needed: z
    .boolean()
    .default(false)
    .describe('Whether the settings URL receives encrypted user_data parameters'),
  is_multiple_salons_allowed: z
    .boolean()
    .default(false)
    .describe('Whether one setup can cover multiple locations'),
  is_iframe: z
    .boolean()
    .default(false)
    .describe('Embed registration_redirect_url inside Altegio instead of opening a new tab'),
  slug: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9_]+$/)
    .describe(
      'Stable application identifier; existing Integrations Hub slugs may contain underscores'
    ),
  is_nonpublic: z.boolean().default(false).describe('Keep the application private/non-public'),
  nonpublic_webhook_url: httpsUrl
    .nullable()
    .optional()
    .describe('Optional webhook URL for a non-public application'),
  monetization_type: z
    .enum(['free', 'paid', 'freemium'])
    .describe('Application monetization model'),
};

export const createApplicationPayload = z.object(baseApplication).strict();

export const updateApplicationPayload = z
  .object({
    ...baseApplication,
    full_description: z.string().default('').describe('Full catalogue description'),
    features_description: z.array(z.string()).describe('Feature description paragraphs'),
    promo_materials: z.array(
      z.object({ type: z.enum(['image', 'video']), content: z.string().min(1) }).strict()
    ),
    questions: z.array(
      z
        .object({ question: z.string().min(3).max(100), answer: z.string().min(3).max(1000) })
        .strict()
    ),
    functionalities: z
      .array(
        z.enum([
          'chat',
          'mass_sendings',
          'service_sendings',
          'cascades',
          'approving',
          'returns',
          'rfm',
          'maps_reviews',
          'interceptor',
          'analytics',
          'tasks',
        ])
      )
      .describe('Validated Marketplace functionality slugs'),
  })
  .strict();

export const installationSettings = z
  .object({
    webhook_urls: z
      .array(httpsUrl)
      .default([])
      .describe('Entity webhook receiver URLs installed for the location'),
    chat_url: httpsUrl.optional().describe('Optional effective chat-frame base URL'),
    tips_url: httpsUrl.optional().describe('Optional tips integration URL'),
    channels: z
      .array(z.enum(['sms', 'whatsapp']))
      .default([])
      .describe('Notification channels enabled during activation'),
    api_key: z.string().min(1).optional().describe('Optional application API key; secret'),
    login: z.string().min(1).optional().describe('Optional application login; secret'),
    secret_key: z.string().min(1).optional().describe('Optional application secret key; secret'),
  })
  .strict();

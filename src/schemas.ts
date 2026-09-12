import { z } from 'zod';

export const positiveId = z.number().int().positive();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
export const mode = z.enum(['plan', 'apply']);
export const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'HTTPS URL required',
  });

export const accountPayload = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    name: z.string().min(1),
    phone: z.string().min(5),
    email: z.string().email(),
    website_url: httpsUrl,
    legal_type: z.enum(['llc', 'cjsc', 'jsc', 'ie', 'np', 'le']).default('llc'),
    country_id: positiveId.optional(),
    company_name: z.string().min(1).optional(),
    reg_number: z.string().min(1).optional(),
    privacy_policy_url: httpsUrl.optional(),
  })
  .strict();

export const createAccountPayload = accountPayload.extend({
  partner_token: z.string().min(1).optional(),
});

const baseApplication = {
  title: z.string().min(3),
  short_description: z.string().min(3),
  icon: z.string().nullable().optional(),
  category_id: positiveId,
  country_ids: z.array(positiveId).min(1),
  website_url: z.union([httpsUrl, z.literal('')]),
  price: z.string(),
  trial_duration: z.number().int().nonnegative(),
  channels: z.array(positiveId),
  permissions: z.record(z.string().min(1), z.union([z.literal(0), z.literal(1)])),
  callback_url: z.union([httpsUrl, z.literal('')]).default(''),
  registration_redirect_url: z.union([httpsUrl, z.literal('')]).default(''),
  is_personal_data_access_needed: z.boolean().default(false),
  is_multiple_salons_allowed: z.boolean().default(false),
  is_iframe: z.boolean().default(false),
  slug: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9]+$/),
  is_nonpublic: z.boolean().default(false),
  nonpublic_webhook_url: httpsUrl.nullable().optional(),
  monetization_type: z.enum(['free', 'paid', 'freemium']),
};

export const createApplicationPayload = z.object(baseApplication).strict();

export const updateApplicationPayload = z
  .object({
    ...baseApplication,
    full_description: z.string().default(''),
    features_description: z.array(z.string()),
    promo_materials: z.array(
      z.object({ type: z.enum(['image', 'video']), content: z.string().min(1) }).strict()
    ),
    questions: z.array(
      z
        .object({ question: z.string().min(3).max(100), answer: z.string().min(3).max(1000) })
        .strict()
    ),
    functionalities: z.array(
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
    ),
  })
  .strict();

export const installationSettings = z
  .object({
    webhook_urls: z.array(httpsUrl).default([]),
    chat_url: httpsUrl.optional(),
    tips_url: httpsUrl.optional(),
    channels: z.array(z.enum(['sms', 'whatsapp'])).default([]),
    api_key: z.string().min(1).optional(),
    login: z.string().min(1).optional(),
    secret_key: z.string().min(1).optional(),
  })
  .strict();

export const specialOffer = z
  .object({
    title: z.string().min(2).max(255),
    description: z.string().min(2),
    short_description: z.string().min(2).max(255),
    url: httpsUrl,
    type_description: z.string().min(2).max(255),
    icon_url: httpsUrl,
    promocode: z.string().min(2).max(255).nullable().optional(),
    expiration_date: date,
    priority: z.number().int().default(0),
  })
  .strict();

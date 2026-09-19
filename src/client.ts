import type { Config } from './config.js';
import { requestContext } from './context.js';
import { MarketplaceError } from './errors.js';

export type AuthLane = 'public' | 'user' | 'partner';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  lane: AuthLane;
  host?: 'api' | 'app';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  partnerToken?: string;
}

interface ApiEnvelope {
  success?: boolean;
  data?: unknown;
  meta?: unknown;
}

export class MarketplaceClient {
  constructor(private readonly config: Config) {}

  private userToken(): string | undefined {
    return requestContext()?.userToken ?? this.config.ALTEGIO_USER_TOKEN;
  }

  async request(path: string, options: RequestOptions): Promise<unknown> {
    const method = options.method ?? 'GET';
    const base =
      options.host === 'app' ? this.config.ALTEGIO_APP_BASE : this.config.ALTEGIO_API_BASE;
    const url = new URL(`${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: 'application/vnd.api.v2+json' };
    if (options.lane !== 'public') {
      const auth = [`Bearer ${options.partnerToken ?? this.config.ALTEGIO_PARTNER_TOKEN}`];
      if (options.lane === 'user') {
        const token = this.userToken();
        if (!token)
          throw new MarketplaceError('An Altegio user token is required for this operation.', 401);
        auth.push(`User ${token}`);
      }
      headers.Authorization = auth.join(', ');
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 1000) };
      }
    }
    if (!response.ok) {
      const envelope = parsed as ApiEnvelope | null;
      throw new MarketplaceError(
        `Altegio request failed (${response.status}) for ${method} ${url.pathname}`,
        response.status,
        envelope?.meta ?? parsed
      );
    }
    return parsed;
  }

  async ownedApplications(partnerId: number): Promise<Array<Record<string, unknown>>> {
    const response = (await this.request(
      `/marketplace/developers/companies/${partnerId}/applications`,
      { lane: 'user' }
    )) as ApiEnvelope;
    const data = response.data ?? response;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  async assertOwnsApplication(partnerId: number, applicationId: number): Promise<void> {
    const applications = await this.ownedApplications(partnerId);
    if (!applications.some((application) => Number(application.id) === applicationId)) {
      throw new MarketplaceError(
        `Application ${applicationId} is not visible in developer account ${partnerId} for the current user.`,
        403
      );
    }
  }

  async partnerTokenForAccount(partnerId: number): Promise<string> {
    const response = (await this.request('/marketplace/developers/companies', {
      lane: 'user',
    })) as ApiEnvelope;
    const accounts = response.data ?? response;
    const account = Array.isArray(accounts)
      ? (accounts as Array<Record<string, unknown>>).find((item) => Number(item.id) === partnerId)
      : undefined;
    const relationship = account?.partner_system as Record<string, unknown> | undefined;
    const partnerSystem = (relationship?.data ?? relationship) as
      Record<string, unknown> | undefined;
    const token = partnerSystem?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new MarketplaceError(
        `Developer account ${partnerId} has no partner-system token visible to the current user.`,
        403
      );
    }
    return token;
  }
}

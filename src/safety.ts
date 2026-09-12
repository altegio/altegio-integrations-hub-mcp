import { MarketplaceError } from './errors.js';

export type ApplyMode = 'plan' | 'apply';

export interface PlannedRequest {
  operation: string;
  method: string;
  path: string;
  body?: unknown;
  warning?: string;
}

export function requireConfirmation(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new MarketplaceError(
      `Confirmation required. Re-run with confirmation exactly: ${expected}`,
      409
    );
  }
}

export function planned(request: PlannedRequest): Record<string, unknown> {
  return {
    ok: true,
    applied: false,
    plan: request,
  };
}

export function requireBackoffice(enabled: boolean, adminToken: string | undefined): string {
  if (!enabled) {
    throw new MarketplaceError(
      'Backoffice tools are disabled. Set ALLOW_BACKOFFICE=true for an approved admin deployment.',
      403
    );
  }
  if (!adminToken) {
    throw new MarketplaceError('Backoffice tools require ALTEGIO_ADMIN_USER_TOKEN.', 401);
  }
  return adminToken;
}

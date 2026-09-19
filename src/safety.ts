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

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export function safeError(error: unknown): { error: string; status?: number; details?: unknown } {
  if (error instanceof MarketplaceError) {
    return { error: error.message, status: error.status, details: error.details };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

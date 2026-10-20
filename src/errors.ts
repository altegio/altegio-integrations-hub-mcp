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

/** A refusal by this server itself, with a class an agent or a log query can match. */
export class ToolRefusal extends Error {
  constructor(
    message: string,
    readonly errorClass: 'rate_limited'
  ) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

export function safeError(error: unknown): {
  error: string;
  status?: number;
  details?: unknown;
  error_class?: string;
} {
  if (error instanceof MarketplaceError) {
    return { error: error.message, status: error.status, details: error.details };
  }
  if (error instanceof ToolRefusal) {
    return { error: error.message, error_class: error.errorClass };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

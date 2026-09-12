const secretKeys = new Set([
  'access_token',
  'api_key',
  'authorization',
  'partner_token',
  'password',
  'refresh_token',
  'secret_key',
  'system_user_token',
  'token',
  'user_token',
]);

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      secretKeys.has(key.toLowerCase()) ? '[REDACTED]' : redactSecrets(nested),
    ])
  );
}

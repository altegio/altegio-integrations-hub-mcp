import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import type { Config } from './config.js';

/** IP literals support the existing private proxy-to-container routes without trusting DNS. */
export function requestGuards(config: Config): RequestHandler {
  const hosts = new Set(
    config.MCP_HTTP_ALLOWED_HOSTS.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const origins = new Set(
    config.MCP_HTTP_ALLOWED_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return (request, response, next): void => {
    let valid: boolean;
    try {
      const raw = request.header('host');
      const url = new URL(`http://${raw}`);
      const host = url.hostname.toLowerCase();
      valid =
        Boolean(raw) &&
        url.host === raw?.toLowerCase() &&
        !url.username &&
        !url.password &&
        (hosts.has(host) || isIP(host.replace(/^\[|\]$/g, '')) !== 0);
      const origin = request.header('origin');
      if (origin !== undefined) valid &&= origins.has(origin);
    } catch {
      valid = false;
    }
    if (!valid) {
      response.status(403).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Host or Origin is not allowed' },
      });
      return;
    }
    next();
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  userToken?: string;
  identity?: string;
}

type HeaderBag = Record<string, string | string[] | undefined>;
const storage = new AsyncLocalStorage<RequestContext>();

function header(headers: HeaderBag, name: string): string | undefined {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function parseRequestContext(headers: HeaderBag): RequestContext {
  const userToken = header(headers, 'x-altegio-user-token')?.trim();
  const subject = header(headers, 'x-mcp-auth-sub')?.trim();
  const email = header(headers, 'x-mcp-auth-email')?.trim();
  return {
    userToken: userToken || undefined,
    identity: subject || email || undefined,
  };
}

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

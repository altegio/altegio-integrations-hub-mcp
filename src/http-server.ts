#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import { loadConfig, type Config } from './config.js';
import { parseRequestContext, runWithContext } from './context.js';
import { createServer } from './server.js';
import { HttpSessionBudget, type HttpSessionLease } from './http-sessions.js';
import { requestGuards } from './http-guards.js';

type TransportMap = Record<string, NodeStreamableHTTPServerTransport>;

/** Docker SIGKILLs a container 10 s after SIGTERM; in-flight requests get most of that. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

function sessionTransport(
  transports: TransportMap,
  sessionId: string | undefined
): NodeStreamableHTTPServerTransport | undefined {
  // Own keys only: a header such as `constructor` is not a session.
  return sessionId && Object.hasOwn(transports, sessionId) ? transports[sessionId] : undefined;
}

/**
 * Sessions live in process memory, so a restart or redeploy forgets them all. The Streamable
 * HTTP transport answers a session ID this process does not hold with 404, which tells the
 * client to start a new session with `initialize`; a missing session ID is 400.
 */
function rejectSessionlessRequest(response: express.Response, sessionId: string | undefined): void {
  if (sessionId) {
    response.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    return;
  }
  response.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: Missing session ID' },
    id: null,
  });
}

export function createApp(
  config: Config,
  options: { maxSessions?: number; idleTimeoutMs?: number } = {}
): { app: express.Express; transports: TransportMap } {
  const app = express();
  const transports: TransportMap = {};
  const budget = new HttpSessionBudget(
    options.maxSessions ?? config.MCP_HTTP_MAX_SESSIONS,
    options.idleTimeoutMs
  );
  const leases = new WeakMap<NodeStreamableHTTPServerTransport, HttpSessionLease>();
  app.disable('x-powered-by');
  app.use('/mcp', requestGuards(config));
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/mcp', async (request, response) => {
    const sessionId = request.header('mcp-session-id');
    let transport = sessionTransport(transports, sessionId);
    const requestId: string | number | null = request.body?.id ?? null;
    let initializing = false;
    if (!transport && !sessionId && isInitializeRequest(request.body)) {
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id): void => {
          transports[id] = transport!;
        },
      });
      const createdTransport = transport;
      const lease = budget.acquire(() => createdTransport.close());
      if (!lease) {
        response.setHeader('Retry-After', '60');
        response.status(503).json({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32000, message: 'MCP session capacity reached; retry later' },
        });
        return;
      }
      leases.set(transport, lease);
      transport.onclose = (): void => {
        lease.release();
        if (createdTransport.sessionId) delete transports[createdTransport.sessionId];
      };
      initializing = true;
    }
    if (!transport) {
      rejectSessionlessRequest(response, sessionId);
      return;
    }
    const lease = leases.get(transport);
    const finish = lease?.beginPost();
    if (finish) {
      response.once('finish', finish);
      response.once('close', finish);
    }
    try {
      // A local stdio credential must never become the fallback identity of an HTTP caller.
      if (initializing)
        await createServer({ ...config, ALTEGIO_USER_TOKEN: undefined }).connect(transport);
      leases.get(transport)?.touch();
      await runWithContext(parseRequestContext(request.headers), () =>
        transport!.handleRequest(request, response, request.body)
      );
      if (initializing && !transport.sessionId) {
        lease?.release();
        await transport.close();
      }
    } catch (error) {
      if (initializing) {
        lease?.release();
        await transport.close();
      }
      throw error;
    }
  });

  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (request, response) => {
      const sessionId = request.header('mcp-session-id');
      const transport = sessionTransport(transports, sessionId);
      if (!transport) {
        rejectSessionlessRequest(response, sessionId);
        return;
      }
      leases.get(transport)?.touch();
      await runWithContext(parseRequestContext(request.headers), () =>
        transport.handleRequest(request, response)
      );
    });
  }
  const errorHandler: express.ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next
  ): void => {
    void _next;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = (error as { status?: number })?.status;
    response.status(status === 400 || status === 413 ? status : 500).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: status === 413 ? 'Request body too large' : 'Request could not be processed',
      },
    });
  };
  app.use(errorHandler);
  return { app, transports };
}

/**
 * Docker stops the container with SIGTERM on every deploy and VM shutdown. The line logged first
 * is how the customer-backend restart alert (altegio-monitoring) tells a deploy from a crash,
 * which logs nothing. Requests in flight then finish, bounded by `timeoutMs`; a session's
 * standalone GET stream never ends by itself, so it is closed rather than waited for.
 */
export async function shutdown(
  server: Server,
  transports: TransportMap,
  signal: NodeJS.Signals,
  timeoutMs = SHUTDOWN_TIMEOUT_MS
): Promise<void> {
  process.stderr.write(`Received ${signal}, shutting down\n`);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const transport of Object.values(transports)) transport.closeStandaloneSSEStream();
  // A finished response leaves its keep-alive socket open for keepAliveTimeout (5 s); close
  // sockets as they go idle so the process exits as soon as the last request ends.
  const sweep = setInterval(() => server.closeIdleConnections(), 100);
  const deadline = setTimeout(() => server.closeAllConnections(), timeoutMs);
  await closed;
  await Promise.allSettled(Object.values(transports).map((transport) => transport.close()));
  clearInterval(sweep);
  clearTimeout(deadline);
}

export function start(config = loadConfig()): Server {
  const { app, transports } = createApp(config);
  const server = app.listen(config.PORT, config.MCP_HTTP_HOST, () =>
    process.stderr.write(
      `Altegio Integrations Hub MCP listening on ${config.PORT}; HTTP session capacity: ${config.MCP_HTTP_MAX_SESSIONS}\n`
    )
  );
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    void shutdown(server, transports, signal).then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (import.meta.main) {
  loadEnv({ quiet: true });
  start();
}

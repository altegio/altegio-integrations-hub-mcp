#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type Config } from './config.js';
import { parseRequestContext, runWithContext } from './context.js';
import { createServer } from './server.js';

type TransportMap = Record<string, StreamableHTTPServerTransport>;

/** Docker SIGKILLs a container 10 s after SIGTERM; in-flight requests get most of that. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

function sessionTransport(
  transports: TransportMap,
  sessionId: string | undefined
): StreamableHTTPServerTransport | undefined {
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

export function createApp(config: Config): { app: express.Express; transports: TransportMap } {
  const app = express();
  const transports: TransportMap = {};
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/mcp', async (request, response) => {
    const sessionId = request.header('mcp-session-id');
    let transport = sessionTransport(transports, sessionId);
    if (!transport && !sessionId && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id): void => {
          transports[id] = transport!;
        },
      });
      transport.onclose = (): void => {
        if (transport?.sessionId) delete transports[transport.sessionId];
      };
      await createServer(config).connect(transport);
    }
    if (!transport) {
      rejectSessionlessRequest(response, sessionId);
      return;
    }
    await runWithContext(parseRequestContext(request.headers), () =>
      transport!.handleRequest(request, response, request.body)
    );
  });

  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (request, response) => {
      const sessionId = request.header('mcp-session-id');
      const transport = sessionTransport(transports, sessionId);
      if (!transport) {
        rejectSessionlessRequest(response, sessionId);
        return;
      }
      await runWithContext(parseRequestContext(request.headers), () =>
        transport.handleRequest(request, response)
      );
    });
  }
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
  clearInterval(sweep);
  clearTimeout(deadline);
}

export function start(config = loadConfig()): Server {
  const { app, transports } = createApp(config);
  const server = app.listen(config.PORT, '0.0.0.0', () =>
    process.stderr.write(`Altegio Integrations Hub MCP listening on ${config.PORT}\n`)
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

if (process.env.NODE_ENV !== 'test') start();

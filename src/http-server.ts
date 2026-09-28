#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type Config } from './config.js';
import { parseRequestContext, runWithContext } from './context.js';
import { createServer } from './server.js';

type TransportMap = Record<string, StreamableHTTPServerTransport>;

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

export function start(config = loadConfig()): void {
  const { app } = createApp(config);
  app.listen(config.PORT, '0.0.0.0', () =>
    process.stderr.write(`Altegio Integrations Hub MCP listening on ${config.PORT}\n`)
  );
}

if (process.env.NODE_ENV !== 'test') start();

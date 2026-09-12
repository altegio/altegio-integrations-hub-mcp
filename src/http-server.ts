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

export function createApp(config: Config): { app: express.Express; transports: TransportMap } {
  const app = express();
  const transports: TransportMap = {};
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/mcp', async (request, response) => {
    const sessionId = request.header('mcp-session-id');
    let transport = sessionId ? transports[sessionId] : undefined;
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
      response.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Invalid or missing MCP session ID' },
      });
      return;
    }
    await runWithContext(parseRequestContext(request.headers), () =>
      transport!.handleRequest(request, response, request.body)
    );
  });

  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (request, response) => {
      const sessionId = request.header('mcp-session-id');
      const transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        response.status(400).json({ error: 'Invalid or missing MCP session ID' });
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
    process.stderr.write(`Altegio Marketplace MCP listening on ${config.PORT}\n`)
  );
}

if (process.env.NODE_ENV !== 'test') start();

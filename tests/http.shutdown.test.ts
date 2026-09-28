import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { jest } from '@jest/globals';
import { createApp, shutdown } from '../src/http-server.js';
import { testConfig } from './helpers.js';

/**
 * Docker stops the container with SIGTERM on every deploy. The stop line is what the restart
 * alert (altegio-monitoring) reads a deploy from, and nothing a client holds open may keep the
 * process alive until Docker's SIGKILL.
 */
describe('HTTP shutdown', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'shutdown-test', version: '1.0.0' },
    },
  };

  const servers: Server[] = [];
  const sockets: Socket[] = [];

  const listen = async (): Promise<
    ReturnType<typeof createApp> & { server: Server; port: number }
  > => {
    const created = createApp({ ...testConfig, ALTEGIO_USER_TOKEN: 'user-token' });
    const server = created.app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    return { ...created, server, port: (server.address() as AddressInfo).port };
  };

  /** A POST /mcp whose headers are sent and whose body is still owed: a request in flight. */
  const startRequest = async (server: Server, port: number, body: string): Promise<Socket> => {
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    const received = once(server, 'request');
    socket.write(
      'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`
    );
    await received;
    return socket;
  };

  let stderr: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    // A regression must fail its test, not hold the run open until the CI timeout.
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close().closeAllConnections();
  });

  test('logs the stop line, ends an open SSE stream and stops listening', async () => {
    const { server, port, transports } = await listen();
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INITIALIZE),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();
    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');

    const started = Date.now();
    await shutdown(server, transports, 'SIGTERM', 5_000);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stderr).toHaveBeenCalledWith('Received SIGTERM, shutting down\n');
    expect(server.listening).toBe(false);
    await stream.text();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test('lets a request in flight finish', async () => {
    const { server, port, transports } = await listen();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const socket = await startRequest(server, port, body);
    let response = '';
    socket.on('data', (chunk) => (response += chunk));

    const started = Date.now();
    const stopped = shutdown(server, transports, 'SIGINT', 5_000);
    socket.write(body.slice(1));
    await stopped;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stderr).toHaveBeenCalledWith('Received SIGINT, shutting down\n');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain('Missing session ID');
  });

  test('closes a request that has not finished by the deadline', async () => {
    const { server, port, transports } = await listen();
    const socket = await startRequest(server, port, '{"jsonrpc":"2.0"}');
    const socketClosed = once(socket, 'close');

    const started = Date.now();
    await shutdown(server, transports, 'SIGTERM', 300);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(2_000);
    await socketClosed;
  });
});

import assert from 'node:assert/strict';

const url = process.argv[2];
assert.ok(url, 'usage: node scripts/smoke-http.mjs MCP_URL');
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
let id = 0;
async function rpc(method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const session = response.headers.get('mcp-session-id');
  if (session) headers['mcp-session-id'] = session;
  const raw = await response.text();
  assert.equal(response.status, 200, `HTTP status for ${method}`);
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? raw
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
    : raw;
  const reply = JSON.parse(data);
  assert.equal(reply.id, id);
  assert.equal(reply.error, undefined, `RPC error for ${method}`);
  return reply.result;
}

try {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'container-smoke', version: '1' },
  });
  headers['MCP-Protocol-Version'] = initialized.protocolVersion;
  const notification = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(10000),
  });
  await notification.arrayBuffer();
  assert.equal(notification.status, 202);
  const result = await rpc('tools/list', {});
  assert.ok(result.tools.length > 0);
  console.log(`MCP initialize/tools/list passed (${result.tools.length} tools)`);
} finally {
  if (headers['mcp-session-id']) {
    const response = await fetch(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10000),
    });
    await response.arrayBuffer();
    assert.equal(response.status, 200, 'session cleanup');
  }
}

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const directory = await mkdtemp(join(tmpdir(), 'hub-package-'));
const npm = (args, cwd) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
let client;
try {
  const packResult = JSON.parse(
    npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root)
  );
  const [packed] = Object.values(packResult);
  assert.ok(packed && Array.isArray(packed.files), 'npm pack metadata');
  const paths = packed.files.map(({ path }) => path);
  assert.ok(paths.includes('dist/index.js') && paths.includes('dist/server.d.ts'));
  assert.ok(
    paths.every((path) =>
      /^(dist\/|docs\/(marketplace-internals|embedded-surfaces|safe-e2e|tool-boundaries|webhooks)\.md$|README\.md$|LICENSE$|package\.json$)/.test(
        path
      )
    ),
    'package allowlist'
  );
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}');
  npm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)],
    directory
  );
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('@altegio/integrations-hub-mcp'); await import('@altegio/integrations-hub-mcp/config'); await import('@altegio/integrations-hub-mcp/http');",
    ],
    { cwd: directory, timeout: 5000, env: { PATH: process.env.PATH } }
  );
  await writeFile(
    join(directory, 'consumer.mts'),
    "import { createServer } from '@altegio/integrations-hub-mcp'; import { loadConfig } from '@altegio/integrations-hub-mcp/config'; const server = createServer(loadConfig({ALTEGIO_PARTNER_TOKEN: 'synthetic'})); await server.close();\n"
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      '--types',
      'node',
      '--typeRoots',
      resolve(root, 'node_modules/@types'),
      join(directory, 'consumer.mts'),
    ],
    { cwd: directory, stdio: 'pipe' }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(directory, 'node_modules/.bin/altegio-integrations-hub-mcp')],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      ALTEGIO_PARTNER_TOKEN: 'synthetic-package-token',
      INTEGRATIONS_HUB_MCP_STATE_DIR: join(directory, 'state'),
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'installed-package-smoke', version: '1' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const catalog = JSON.parse(await readFile(join(root, 'docs/tools.json'), 'utf8'));
  assert.deepEqual(tools.map(({ name }) => name).sort(), catalog.map(({ name }) => name).sort());
  assert.ok(
    !tools.some(({ name }) => /backoffice|publish_application|moderate_application/.test(name))
  );
  const { resources } = await client.listResources();
  assert.equal(resources.length, 5);
  for (const resource of resources) {
    const result = await client.readResource({ uri: resource.uri });
    assert.ok(result.contents[0].text.length > 100);
  }
  const prompt = await client.getPrompt({
    name: 'integrations_hub_safe_draft_rollout',
    arguments: { partner_id: '3', location_id: '55' },
  });
  assert.ok(prompt.messages.length);
  const plan = await client.callTool({
    name: 'integrations_hub_delete_developer_account',
    arguments: { partner_id: 3, mode: 'plan' },
  });
  assert.ok(!plan.isError);
  assert.equal(plan.structuredContent.applied, false);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const http = spawn(
    process.execPath,
    [join(directory, 'node_modules/.bin/altegio-integrations-hub-mcp-http')],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        ALTEGIO_PARTNER_TOKEN: 'synthetic-http-token',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  const closed = once(http, 'close');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP executable did not start')), 10000);
      let output = '';
      http.once('error', reject);
      http.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('HTTP executable exited before readiness'));
      });
      http.stderr.on('data', (chunk) => {
        output = (output + chunk).slice(-4096);
        if (output.includes(`listening on ${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    execFileSync(
      process.execPath,
      [join(root, 'scripts/smoke-http.mjs'), `http://127.0.0.1:${port}/mcp`],
      { cwd: directory, timeout: 30000, stdio: 'pipe' }
    );
  } finally {
    http.kill('SIGTERM');
    const force = setTimeout(() => http.kill('SIGKILL'), 10000);
    const [code] = await closed;
    clearTimeout(force);
    assert.equal(code, 0, 'HTTP executable shutdown');
  }
  console.log(
    `Installed tarball: exports, types, stdio/HTTP executables, ${tools.length} tools, ${resources.length} resources, prompt and no-write plan passed`
  );
} finally {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
}

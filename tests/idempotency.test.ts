import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdempotencyStore } from '../src/idempotency.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-idempotency-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const key = 'synthetic-operation';
const filename = (): string =>
  join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

test('exclusive reservations survive separate processes and block ambiguous replays', async () => {
  const code = `import { IdempotencyStore } from './src/idempotency.ts'; const store = new IdempotencyStore(process.argv[1]); try { await store.reserve('${key}', 'fingerprint'); console.log('reserved'); } catch (error) { if (error.status !== 409) throw error; console.log('conflict'); }`;
  const results = await Promise.all(
    [0, 1].map(() =>
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        code,
        directory,
      ])
    )
  );
  expect(results.map(({ stdout }) => stdout.trim()).sort()).toEqual(['conflict', 'reserved']);
  await expect(new IdempotencyStore(directory).get(key, 'fingerprint')).rejects.toThrow(
    /reconcil/i
  );
});

test('completed state is private, redacted and readable by a new instance', async () => {
  const store = new IdempotencyStore(directory);
  await store.reserve(key, 'fingerprint');
  await store.put(key, 'fingerprint', { id: 123, token: 'synthetic-private-token' });
  expect(await new IdempotencyStore(directory).get(key, 'fingerprint')).toEqual({
    id: 123,
    token: '[REDACTED]',
  });
  expect(await readFile(filename(), 'utf8')).not.toContain('synthetic-private-token');
  if (process.platform !== 'win32') expect((await stat(filename())).mode & 0o777).toBe(0o600);
});

test('reads legacy completed records and fails closed on corrupt state', async () => {
  await writeFile(
    filename(),
    JSON.stringify({ fingerprint: 'fingerprint', result: { id: 123 }, createdAt: '2026-01-01' })
  );
  const store = new IdempotencyStore(directory);
  expect(await store.get(key, 'fingerprint')).toEqual({ id: 123 });
  await writeFile(filename(), '{"fingerprint":"fingerprint"}');
  await expect(store.get(key, 'fingerprint')).rejects.toThrow(/reconcil/i);
});

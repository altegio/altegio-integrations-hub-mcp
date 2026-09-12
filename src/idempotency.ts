import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Entry {
  fingerprint: string;
  result: unknown;
  createdAt: string;
}

export class IdempotencyStore {
  private static readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  private file(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return join(this.directory, `${hash}.json`);
  }

  fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  async withLock<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const lockKey = this.file(key);
    const previous = IdempotencyStore.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    IdempotencyStore.locks.set(lockKey, queued);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (IdempotencyStore.locks.get(lockKey) === queued) {
        IdempotencyStore.locks.delete(lockKey);
      }
    }
  }

  async get(key: string, fingerprint: string): Promise<unknown | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as Entry;
      if (entry.fingerprint !== fingerprint) {
        throw new Error('Idempotency key was already used with a different payload.');
      }
      return entry.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(key: string, fingerprint: string, result: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ fingerprint, result, createdAt: new Date().toISOString() } satisfies Entry),
      { mode: 0o600 }
    );
    await rename(temporary, target);
  }
}

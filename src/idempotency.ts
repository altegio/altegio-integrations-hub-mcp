import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MarketplaceError } from './errors.js';
import { redactSecrets } from './redact.js';

interface Entry {
  fingerprint: string;
  result: unknown;
  createdAt: string;
  state?: 'pending' | 'complete';
}

export class IdempotencyStore {
  private static readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  private async syncDirectory(): Promise<void> {
    // Windows does not support opening a directory for fsync. Production uses Linux.
    if (process.platform === 'win32') return;
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private file(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return resolve(this.directory, `${hash}.json`);
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
        throw new MarketplaceError(
          'Idempotency key was already used with a different payload.',
          409
        );
      }
      if (entry.state === 'pending') {
        throw new MarketplaceError(
          'This financial operation is pending or has an unknown outcome. Reconcile it with Altegio before retrying; do not use a new key.',
          409
        );
      }
      if (!Object.hasOwn(entry, 'result') || entry.result === undefined) {
        throw new MarketplaceError('Invalid idempotency record; reconciliation is required.', 409);
      }
      return entry.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Exclusive durable reservation also prevents separate processes from replaying a write. */
  async reserve(key: string, fingerprint: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(this.file(key), 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new MarketplaceError(
          'Financial operation already reserved; reconciliation is required.',
          409
        );
      }
      throw error;
    });
    try {
      await file.writeFile(
        JSON.stringify({ fingerprint, state: 'pending', createdAt: new Date().toISOString() })
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await this.syncDirectory();
  }

  async put(key: string, fingerprint: string, result: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(
          JSON.stringify({
            fingerprint,
            result: redactSecrets(result),
            state: 'complete',
            createdAt: new Date().toISOString(),
          } satisfies Entry)
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      await this.syncDirectory();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

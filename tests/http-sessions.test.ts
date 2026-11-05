import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpSessionBudget } from '../src/http-sessions.js';

describe('HTTP session memory budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps concurrent reservations and frees a slot after idle expiry', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    expect(budget.acquire(close)).toBeDefined();
    expect(budget.acquire(close)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1);
    expect(budget.acquire(close)).toBeDefined();
  });

  it('refreshes idle time on activity, including SSE reconnects', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lease = budget.acquire(close)!;
    await vi.advanceTimersByTimeAsync(90);
    lease.touch();
    await vi.advanceTimersByTimeAsync(90);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not expire long-running or overlapping POST responses', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lease = budget.acquire(close)!;
    const first = lease.beginPost();
    const second = lease.beginPost();
    await vi.advanceTimersByTimeAsync(1000);
    first();
    first(); // finish and close can both fire for one response
    lease.touch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases terminated or failed initializations without closing twice', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const lease = budget.acquire(close)!;
    const finish = lease.beginPost();
    lease.release();
    lease.release();
    finish();
    lease.touch();
    expect(budget.acquire(close)).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1); // only the replacement expired
  });
});

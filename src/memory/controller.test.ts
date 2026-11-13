import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryValidationError } from './consolidator';
import type { ConsolidationResult } from './consolidator';
import {
  createMemoryController,
  MEMORY_COUNT_THROTTLE_MS,
  MEMORY_MAX_VALIDATION_FAILURES,
  MEMORY_RETRY_BASE_MS,
} from './controller';
import { DEFAULT_MEMORY_CONFIG } from './types';
import type { CompactionSessionMeta } from '../driver/types';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);

const context = (receivedAtMs: number): RenderedContext => [{ receivedAtMs, content: [{ type: 'text', text: 'x' }] }];

const compaction = (cursor: number): CompactionSessionMeta => ({
  oldCursorMs: 0, newCursorMs: cursor, summary: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
});

const result = (endMs: number): ConsolidationResult =>
  ({ kind: 'applied', fromMs: 0, endMs, humanMessages: 40, truncated: false, opsApplied: 1, opsRejected: 0 });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const make = (options: { count?: number; initialMeta?: CompactionSessionMeta | null; initialContext?: RenderedContext } = {}) => {
  let cursor = 0;
  const rc = signal<RenderedContext>(options.initialContext ?? []);
  const meta = signal<CompactionSessionMeta | null>(options.initialMeta ?? null);
  const deps = {
    loadCursor: vi.fn(() => cursor),
    advanceCursor: vi.fn((_chat: string, ms: number) => { cursor = ms; }),
    recordError: vi.fn(),
    countHumanMessagesSince: vi.fn(() => options.count ?? 40),
    consolidate: vi.fn(async (_from: number) => result(1_000)),
  };
  const controller = createMemoryController({
    chatId: 'oc_chat',
    config: { ...DEFAULT_MEMORY_CONFIG, enabled: true, triggerMessages: 40 },
    context: rc,
    compactionMeta: meta,
    blockedUserIds: ['ou_blocked'],
    ...deps,
    log: useLogger('memory-controller-test'),
  });
  return { rc, meta, deps, controller, cursor: () => cursor };
};

// A timer that fires exactly at the end of an advance schedules its follow-up
// check at the same instant; the extra few ms let that one run too.
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms + 5);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('memory controller triggers', () => {
  it('does nothing at construction, including the compaction signal\'s first firing', async () => {
    const { deps } = make({ initialMeta: compaction(5) });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.consolidate).not.toHaveBeenCalled();
    expect(deps.countHumanMessagesSince).not.toHaveBeenCalled();
  });

  it('runs when the DB count reaches triggerMessages and then moves the cursor', async () => {
    const { rc, deps, cursor } = make({ count: 40 });
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.countHumanMessagesSince).toHaveBeenCalledWith('oc_chat', 0, ['ou_blocked']);
    expect(deps.consolidate).toHaveBeenCalledWith(0);
    expect(deps.advanceCursor).toHaveBeenCalledWith('oc_chat', 1_000, null);
    expect(cursor()).toBe(1_000);
  });

  it('stays quiet below the threshold', async () => {
    const { rc, deps } = make({ count: 39 });
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.consolidate).not.toHaveBeenCalled();
  });

  it('runs on a compaction change without counting messages', async () => {
    const { meta, deps } = make({ count: 0 });
    meta(compaction(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.consolidate).toHaveBeenCalledTimes(1);
    expect(deps.countHumanMessagesSince).not.toHaveBeenCalled();
  });

  it('counts at most once per throttle interval during a burst, then rechecks once', async () => {
    const { rc, deps } = make({ count: 3 });
    for (let index = 1; index <= 200; index++) {
      rc(context(index));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(deps.countHumanMessagesSince).toHaveBeenCalledTimes(1);
    await advance(MEMORY_COUNT_THROTTLE_MS);
    expect(deps.countHumanMessagesSince).toHaveBeenCalledTimes(2);
  });

  it('rechecks the latest state once after a trigger that arrived during a run', async () => {
    const first = deferred<ConsolidationResult>();
    const { rc, deps } = make({ count: 40 });
    deps.consolidate.mockImplementationOnce(async () => await first.promise);
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.consolidate).toHaveBeenCalledTimes(1);
    rc(context(2));
    rc(context(3));
    first.resolve(result(1_000));
    await advance(MEMORY_COUNT_THROTTLE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(2);
  });
});

describe('memory controller failures', () => {
  it('latches provider errors with a doubling backoff and rechecks at expiry', async () => {
    const { rc, deps, controller } = make({ count: 40 });
    deps.consolidate.mockRejectedValue(new Error('HTTP 503'));
    expect(controller.consecutiveFailures()).toBe(0);
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.consolidate).toHaveBeenCalledTimes(1);
    expect(controller.consecutiveFailures()).toBe(1);
    expect(deps.recordError).toHaveBeenCalledWith('oc_chat', 'HTTP 503');
    expect(deps.advanceCursor).not.toHaveBeenCalled();

    // context changes while latched are ignored
    rc(context(2));
    await vi.advanceTimersByTimeAsync(MEMORY_RETRY_BASE_MS - 1_000);
    expect(deps.consolidate).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(deps.consolidate).toHaveBeenCalledTimes(2);

    // the second failure doubles the wait
    await vi.advanceTimersByTimeAsync(MEMORY_RETRY_BASE_MS * 2 - 1_000);
    expect(deps.consolidate).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(deps.consolidate).toHaveBeenCalledTimes(3);
    expect(controller.consecutiveFailures()).toBe(3);
  });

  it('treats a failing count query like any other failure instead of leaking a rejection', async () => {
    const { rc, deps } = make({ count: 40 });
    deps.countHumanMessagesSince.mockImplementationOnce(() => {
      throw new Error('database is closed');
    });
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.recordError).toHaveBeenCalledWith('oc_chat', 'database is closed');
    expect(deps.consolidate).not.toHaveBeenCalled();
  });

  it('clears the latch after a success', async () => {
    const { rc, deps } = make({ count: 40 });
    deps.consolidate.mockRejectedValueOnce(new Error('HTTP 503'));
    rc(context(1));
    await advance(MEMORY_RETRY_BASE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(2);
    expect(deps.advanceCursor).toHaveBeenCalledTimes(1);
    rc(context(2));
    await advance(MEMORY_COUNT_THROTTLE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(3);
  });

  it('keeps the compaction flush owed while latched', async () => {
    const { rc, meta, deps } = make({ count: 40 });
    deps.consolidate.mockRejectedValueOnce(new Error('HTTP 503'));
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    deps.countHumanMessagesSince.mockReturnValue(0);
    meta(compaction(9));
    await advance(MEMORY_RETRY_BASE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(2);
  });

  it('skips a window after repeated validation failures on it, and records the range', async () => {
    const { rc, deps, cursor } = make({ count: 40 });
    deps.consolidate.mockRejectedValue(new MemoryValidationError('unparseable_json', 0, 7_000));
    rc(context(1));
    for (let attempt = 1; attempt <= MEMORY_MAX_VALIDATION_FAILURES; attempt++) {
      await advance(attempt === 1 ? 0 : MEMORY_RETRY_BASE_MS * 2 ** (attempt - 2));
    }
    expect(deps.consolidate).toHaveBeenCalledTimes(MEMORY_MAX_VALIDATION_FAILURES);
    expect(deps.advanceCursor).toHaveBeenCalledWith('oc_chat', 7_000, expect.stringContaining('unparseable_json'));
    expect(cursor()).toBe(7_000);
    // the latch is gone: the next message batch is processed normally
    deps.consolidate.mockResolvedValue(result(9_000));
    rc(context(2));
    await advance(MEMORY_COUNT_THROTTLE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(MEMORY_MAX_VALIDATION_FAILURES + 1);
    expect(deps.consolidate).toHaveBeenLastCalledWith(7_000);
  });

  it('does not skip anything for provider errors, however many', async () => {
    const { rc, deps } = make({ count: 40 });
    deps.consolidate.mockRejectedValue(new Error('timeout'));
    rc(context(1));
    for (let attempt = 0; attempt < 6; attempt++) await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.consolidate.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('restarts the validation count when the window moves or a run succeeds', async () => {
    const { rc, deps } = make({ count: 40 });
    deps.consolidate
      .mockRejectedValueOnce(new MemoryValidationError('empty_output', 0, 5_000))
      .mockRejectedValueOnce(new MemoryValidationError('empty_output', 0, 5_000))
      .mockResolvedValueOnce(result(5_000))
      .mockRejectedValue(new MemoryValidationError('empty_output', 5_000, 9_000));
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    await advance(MEMORY_RETRY_BASE_MS);
    await advance(MEMORY_RETRY_BASE_MS * 2);
    expect(deps.advanceCursor).toHaveBeenCalledTimes(1);
    expect(deps.advanceCursor).toHaveBeenCalledWith('oc_chat', 5_000, null);
    rc(context(2));
    await advance(MEMORY_COUNT_THROTTLE_MS);
    expect(deps.consolidate).toHaveBeenCalledTimes(4);
    // one failure on a new window is not three
    expect(deps.advanceCursor).toHaveBeenCalledTimes(1);
  });
});

describe('memory controller dispose', () => {
  it('stops reacting to both triggers and clears its timers', async () => {
    const { rc, meta, deps, controller } = make({ count: 40 });
    rc(context(1));
    controller.dispose();
    await vi.advanceTimersByTimeAsync(10 * MEMORY_COUNT_THROTTLE_MS);
    rc(context(2));
    meta(compaction(9));
    await vi.advanceTimersByTimeAsync(10 * MEMORY_COUNT_THROTTLE_MS);
    expect(deps.consolidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the cursor alone for a run that outlives dispose, so the next start replays it', async () => {
    const pending = deferred<ConsolidationResult>();
    const { rc, deps, controller } = make({ count: 40 });
    deps.consolidate.mockImplementationOnce(async () => await pending.promise);
    rc(context(1));
    await vi.advanceTimersByTimeAsync(0);
    controller.dispose();
    pending.resolve(result(1_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

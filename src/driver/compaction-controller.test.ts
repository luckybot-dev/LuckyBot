import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./compaction', async importOriginal => ({
  ...(await importOriginal<typeof import('./compaction')>()),
  runCompaction: vi.fn(),
}));

import { runCompaction } from './compaction';
import { COMPACTION_RETRY_BASE_MS, createCompactionController } from './compaction-controller';
import { DEFAULT_TURN_BUDGET } from './turn-loop';
import type { CompactionSessionMeta } from './types';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

const context = (receivedAtMs: number): RenderedContext => [{
  receivedAtMs,
  content: [{ type: 'text', text: 'long context' }],
}];

const meta = (cursor: number): CompactionSessionMeta => ({
  oldCursorMs: 0,
  newCursorMs: cursor,
  summary: `summary ${cursor}`,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const makeController = (rendered: ReturnType<typeof signal<RenderedContext>>) =>
  createCompactionController({
    chatId: 'chat',
    chatConfig: {
      primary: {
        model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'model', apiFormat: 'openai-chat' },
        turnBudget: DEFAULT_TURN_BUDGET,
        reasoningReplayTurns: 3,
      },
      systemFiles: [],
      sendTypingAction: false,
      blockedUserIds: [],
      debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 1 },
      compaction: { maxContextEstTokens: 1, workingWindowEstTokens: 1 },
      probe: { model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'probe', apiFormat: 'openai-chat' }, timeoutMs: 1_000, contextEstTokens: 20_000, summaryMaxEstTokens: 20_000 },
      participation: { style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' },
      memory: DEFAULT_MEMORY_CONFIG,
      imageToText: { enabled: false, maxConcurrency: 1 },
      animationToText: { enabled: false, maxFrames: 1, maxConcurrency: 1 },
      customEmojiToText: { enabled: false, maxFrames: 1, maxConcurrency: 1 },
      plugins: {},
      tools: { banSpammer: false, bash: { enabled: true, backgroundThresholdSec: 10, requireMaintainer: true, maintainerWindowSec: 600 } },
    },
    context: rendered,
    compactionMeta: signal<CompactionSessionMeta | null>(null),
    loadTurnResponses: async () => [],
    persistCompaction: vi.fn(),
    setCompactCursor: () => rendered(),
    log: useLogger('compaction-controller-test'),
  });

describe('createCompactionController', () => {
  beforeEach(() => {
    vi.mocked(runCompaction).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('rechecks the latest context after a running compaction settles', async () => {
    vi.useFakeTimers();
    const first = deferred<CompactionSessionMeta>();
    vi.mocked(runCompaction)
      .mockImplementationOnce(async () => await first.promise)
      .mockResolvedValueOnce(meta(2));
    const rendered = signal(context(1));
    const controller = makeController(rendered);

    await vi.advanceTimersByTimeAsync(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    rendered(context(2));
    first.resolve(meta(1));
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(runCompaction).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('latches failed compactions with exponential backoff and resets on success', async () => {
    vi.useFakeTimers();
    vi.mocked(runCompaction)
      .mockRejectedValueOnce(new Error('provider down 1'))
      .mockRejectedValueOnce(new Error('provider down 2'))
      .mockResolvedValue(meta(1));
    const rendered = signal(context(1));
    const controller = makeController(rendered);
    const advance = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
      await Promise.resolve();
      await Promise.resolve();
    };

    await advance(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    expect(controller.consecutiveFailures()).toBe(1);

    // Inside the 5-minute latch a new context does not retry.
    rendered(context(2));
    await advance(1_000);
    expect(runCompaction).toHaveBeenCalledTimes(1);

    // The latch expires and retries with the latest context.
    await advance(COMPACTION_RETRY_BASE_MS);
    expect(runCompaction).toHaveBeenCalledTimes(2);

    // Second failure doubles the delay: +5 min is still latched, +10 min retries.
    rendered(context(3));
    await advance(COMPACTION_RETRY_BASE_MS);
    expect(runCompaction).toHaveBeenCalledTimes(2);
    expect(controller.consecutiveFailures()).toBe(2);
    await advance(COMPACTION_RETRY_BASE_MS);
    expect(runCompaction).toHaveBeenCalledTimes(3);

    // Success clears the latch: the next context change runs immediately.
    rendered(context(4));
    await advance(0);
    expect(runCompaction).toHaveBeenCalledTimes(4);
    expect(controller.consecutiveFailures()).toBe(0);
    controller.dispose();
  });

  it('caps the compaction window at the input budget and advances only to its end', async () => {
    vi.useFakeTimers();
    vi.mocked(runCompaction).mockImplementation(async params => ({
      oldCursorMs: params.oldCursorMs,
      newCursorMs: params.newCursorMs,
      summary: 'summary',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    // 25 segments of 1000 est tokens each = 25K, above the 20K+1 cap.
    const bigContext: RenderedContext = Array.from({ length: 25 }, (_, i) => ({
      receivedAtMs: i + 1,
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
    }));
    const rendered = signal(bigContext);
    const controller = makeController(rendered);

    await vi.advanceTimersByTimeAsync(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runCompaction).mock.calls[0]![0];
    // Forward from oldCursor: 20 segments fit (20000 ≤ 20001), so the window is
    // exactly those and the cursor stops after the 20th instead of jumping to
    // the planned working-window start (26).
    expect(params.newCursorMs).toBe(21);
    expect(params.rcWindow).toHaveLength(20);
    expect(params.rcWindow[0]!.receivedAtMs).toBe(1);
    expect(params.rcWindow.at(-1)!.receivedAtMs + 1).toBe(params.newCursorMs);
    expect(params.rcWindow.length * 1000).toBeLessThanOrEqual(20001);
    controller.dispose();
  });

  it('caps a 3x backlog window at the budget, starting at the old cursor', async () => {
    vi.useFakeTimers();
    vi.mocked(runCompaction).mockImplementation(async params => ({
      oldCursorMs: params.oldCursorMs,
      newCursorMs: params.newCursorMs,
      summary: 'summary',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    // 60 segments of 1000 est tokens each = 60K, about 3× the ~20K cap.
    const backlog: RenderedContext = Array.from({ length: 60 }, (_, i) => ({
      receivedAtMs: i + 1,
      content: [{ type: 'text', text: 'x'.repeat(2000) }],
    }));
    const rendered = signal(backlog);
    const controller = makeController(rendered);

    await vi.advanceTimersByTimeAsync(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runCompaction).mock.calls[0]![0];
    expect(params.oldCursorMs).toBe(0);
    expect(params.rcWindow[0]!.receivedAtMs).toBe(1);
    expect(params.rcWindow.at(-1)!.receivedAtMs + 1).toBe(params.newCursorMs);
    expect(params.rcWindow.length * 1000).toBeLessThanOrEqual(20001);
    // Only the fitting prefix is summarized; the rest waits for the next round.
    expect(params.newCursorMs).toBeLessThan(61);
    controller.dispose();
  });

  it('includes an oversized first entry so the cursor always advances', async () => {
    vi.useFakeTimers();
    vi.mocked(runCompaction).mockImplementation(async params => ({
      oldCursorMs: params.oldCursorMs,
      newCursorMs: params.newCursorMs,
      summary: 'summary',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }));
    // A single 50K-token segment, far above the ~20K cap.
    const rendered = signal<RenderedContext>([{
      receivedAtMs: 1,
      content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    }]);
    const controller = makeController(rendered);

    await vi.advanceTimersByTimeAsync(0);
    expect(runCompaction).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runCompaction).mock.calls[0]![0];
    expect(params.newCursorMs).toBe(2);
    expect(params.rcWindow).toHaveLength(1);
    controller.dispose();
  });
});

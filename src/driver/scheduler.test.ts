import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReplyScheduler } from './scheduler';
import type { WakeupOutcome, WakeupRetry } from './scheduler';
import { createWakeupHealth } from './wakeup-health';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);
const log = useLogger('scheduler-test');

const segment = (receivedAtMs: number, senderId: string): RenderedContext[number] => ({
  receivedAtMs,
  senderId,
  content: [{ type: 'text', text: senderId }],
});

const DONE: WakeupOutcome = { kind: 'done' };
const FAILURE: WakeupOutcome = { kind: 'failure' };
const TRANSIENT: WakeupOutcome = { kind: 'transient-failure' };

const debounce = { initialDelayMs: 100, typingExtendMs: 100, maxDelayMs: 500 };

const makeScheduler = (overrides: Partial<Parameters<typeof createReplyScheduler>[0]> = {}) => {
  const context = signal<RenderedContext>([segment(1000, 'a')]);
  const lastProcessedMs = signal(0);
  const failedContext = signal<RenderedContext | null>(null);
  const execute = vi.fn(async (_context: RenderedContext, _retry?: WakeupRetry): Promise<WakeupOutcome> => DONE);
  const scheduler = createReplyScheduler({
    chatId: 'chat',
    debounce,
    context,
    lastProcessedMs,
    lastTurnInterrupted: signal(false),
    failedContext,
    execute,
    onDebounceStateChange: () => {},
    retryDelaysMs: [1000, 3000],
    log,
    ...overrides,
  });
  return { scheduler, context, lastProcessedMs, failedContext, execute };
};

describe('createReplyScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not extend the trigger sender deadline for another sender', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, execute } = makeScheduler();

    vi.setSystemTime(1050);
    context([segment(1000, 'a'), segment(1050, 'b')]);
    await vi.advanceTimersByTimeAsync(50);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('extends for typing but never past the hard cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler({
      debounce: { initialDelayMs: 100, typingExtendMs: 300, maxDelayMs: 250 },
    });

    vi.setSystemTime(1050);
    scheduler.notifyTyping();
    await vi.advanceTimersByTimeAsync(199);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('does not rerun a context after a permanent failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, failedContext, execute } = makeScheduler();
    execute.mockResolvedValue(FAILURE);

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(failedContext()).toBe(context());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('retries a transient failure on the same context with backoff, then gives up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, failedContext, execute } = makeScheduler();
    // The probe ran and advanced the watermark before primary failed, so the
    // context alone no longer needs a reply; the retry must still fire.
    execute.mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return TRANSIENT;
    });
    const initial = context();

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(initial);
    expect(execute.mock.calls[0]![1]).toBeUndefined();
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: undefined });
    expect(failedContext()).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(failedContext()).toBe(initial);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('stops retrying once an attempt succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, failedContext, execute } = makeScheduler();
    execute.mockResolvedValueOnce(TRANSIENT).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedContext()).toBeNull();
    scheduler.dispose();
  });

  it('lets new input during the backoff supersede the retry with a debounced fresh wake-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler({ retryDelaysMs: [10_000] });
    execute.mockImplementationOnce(async () => TRANSIENT).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    vi.setSystemTime(2000);
    const newer = [segment(1000, 'a'), segment(2000, 'b')];
    context(newer);
    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(newer);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('lets new external input supersede a primary-failure retry without carrying its activation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const debug = vi.fn();
    const stubLog = { withFields: () => ({ debug, log: () => {}, warn: () => {}, error: () => {} }) } as unknown as Logger;
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler({ retryDelaysMs: [10_000], log: stubLog });
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked' } };
    }).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });

    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(2000);
    const newer = [segment(1000, 'a'), segment(2000, 'b')];
    context(newer);
    expect(debug).toHaveBeenCalledWith('Pending retry superseded by new input');
    await vi.advanceTimersByTimeAsync(99);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(newer);
    expect(execute.mock.calls[1]![1]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('passes a probe activation from the failed attempt into the retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked directly' } };
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: { reason: 'asked directly' } });
    scheduler.dispose();
  });

  it.each([
    ['a same-content replacement array (compaction)', () => [segment(1000, 'a')]],
    ['an in-place edit', () => [{ ...segment(1000, 'a'), content: [{ type: 'text' as const, text: 'edited' }] }]],
    ['a self-sent event', () => [segment(1000, 'a'), { ...segment(1050, 'bot'), isMyself: true }]],
  ])('keeps the retry live across %s and runs it against the current context', async (_name, replacement) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, failedContext, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      // Probe advanced the watermark before primary failed.
      lastProcessedMs(Date.now());
      return { kind: 'transient-failure', probeActivation: { reason: 'asked' } };
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    const replaced = replacement();
    context(replaced);
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(replaced);
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: { reason: 'asked' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedContext()).toBeNull();
    scheduler.dispose();
  });

  it('does not let typing during the backoff postpone or duplicate the retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, execute } = makeScheduler();
    execute.mockImplementationOnce(async () => {
      lastProcessedMs(Date.now());
      return TRANSIENT;
    }).mockResolvedValue(DONE);

    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(100);
      scheduler.notifyTyping();
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('handles new input that arrives while a retry attempt is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, lastProcessedMs, execute } = makeScheduler();
    let releaseRetry: (outcome: WakeupOutcome) => void = () => {};
    execute
      .mockImplementationOnce(async () => {
        lastProcessedMs(Date.now());
        return TRANSIENT;
      })
      .mockImplementationOnce(() => new Promise<WakeupOutcome>(resolve => { releaseRetry = resolve; }))
      .mockImplementation(async () => {
        lastProcessedMs(Date.now());
        return DONE;
      });

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);
    const newer = [segment(1000, 'a'), segment(Date.now(), 'b')];
    context(newer);
    // Calls are serialized: nothing starts while the retry attempt runs.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledTimes(2);

    // The running attempt fails again; its retry is stale against the new
    // context, so exactly one fresh, debounced wake-up runs for the new input.
    releaseRetry(TRANSIENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]![0]).toBe(newer);
    expect(execute.mock.calls[2]![1]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('cancels a pending retry on dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler();
    execute.mockResolvedValue(TRANSIENT);

    await vi.advanceTimersByTimeAsync(100);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('createReplyScheduler watchdog rearm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no failure until a wake-up is abandoned, then a rearmable one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler();
    execute.mockResolvedValue(FAILURE);
    expect(scheduler.status()).toEqual({ busy: false, failure: null });

    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.status()).toEqual({ busy: false, failure: { sinceMs: 1100, rearmed: false, rearmable: true } });
    scheduler.dispose();
  });

  it('rearms an abandoned context once, so a second failure stays failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const health = createWakeupHealth();
    const { scheduler, context, failedContext, execute } = makeScheduler({ health });
    execute.mockResolvedValue(FAILURE);
    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    const failed = context();

    expect(scheduler.rearmFailed()).toBe(true);
    expect(failedContext()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0]).toBe(failed);
    // The rearmed run failed again: failed for good, flagged, not rearmable.
    expect(failedContext()).toBe(failed);
    expect(scheduler.status().failure).toMatchObject({ rearmed: true });
    expect(scheduler.rearmFailed()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(health.counters().abandoned).toBe(2);
    scheduler.dispose();
  });

  it('clears the failure when the rearmed run succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, failedContext, execute } = makeScheduler();
    execute.mockResolvedValueOnce(FAILURE).mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return DONE;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(scheduler.rearmFailed()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(failedContext()).toBeNull();
    expect(scheduler.status()).toEqual({ busy: false, failure: null });
    scheduler.dispose();
  });

  it('does not rearm while a transient retry is pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler();
    execute.mockResolvedValueOnce(TRANSIENT).mockResolvedValue(DONE);
    await vi.advanceTimersByTimeAsync(100);

    expect(scheduler.status()).toEqual({ busy: true, failure: null });
    expect(scheduler.rearmFailed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('is busy and refuses a rearm while a rearmed run is executing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, execute } = makeScheduler();
    let release!: () => void;
    execute.mockResolvedValueOnce(FAILURE).mockImplementationOnce(() => new Promise<WakeupOutcome>(resolve => {
      release = () => resolve(FAILURE);
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.rearmFailed()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.status().busy).toBe(true);
    expect(scheduler.rearmFailed()).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status().busy).toBe(false);
    scheduler.dispose();
  });

  it('refuses a rearm when nothing is owed: watermark past the input and no activation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, execute } = makeScheduler();
    execute.mockImplementation(async () => {
      lastProcessedMs(Date.now());
      return FAILURE;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(scheduler.status().failure).toMatchObject({ rearmable: false });
    expect(scheduler.rearmFailed()).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('rearms a probe-activated failure with its activation and a fresh retry count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, lastProcessedMs, failedContext, execute } = makeScheduler({ retryDelaysMs: [1000] });
    const activation = { reason: 'asked directly' };
    execute.mockImplementation(async (_context, retry) => {
      lastProcessedMs(Date.now());
      return execute.mock.calls.length === 1
        ? { kind: 'failure', probeActivation: activation }
        : retry ? { kind: 'transient-failure', probeActivation: activation } : DONE;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(failedContext()).not.toBeNull();

    expect(scheduler.rearmFailed()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![1]).toEqual({ probeActivation: activation });
    // Fresh count: the transient failure of the rearmed run still earns its retry.
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('does not rearm a stale failure after the context changed on its own', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { scheduler, context, execute } = makeScheduler();
    execute.mockResolvedValue(FAILURE);
    await vi.advanceTimersByTimeAsync(100);

    context([segment(1000, 'a'), segment(2000, 'b')]);
    expect(scheduler.status().failure).toBeNull();
    expect(scheduler.rearmFailed()).toBe(false);
    scheduler.dispose();
  });
});

describe('createReplyScheduler failure records', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const recordingLog = () => {
    const records: { level: string; message: string; fields: Record<string, unknown> }[] = [];
    const log = {
      withFields: (fields: Record<string, unknown>) => {
        const at = (level: string) => (message: string) => { records.push({ level, message, fields }); };
        return { debug: at('debug'), log: at('log'), warn: at('warn'), error: at('error') };
      },
    } as unknown as Logger;
    return { log, records };
  };

  it('logs each failure with stage and attempt, and one distinct abandoned warning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { log, records } = recordingLog();
    const { scheduler, execute } = makeScheduler({ log, retryDelaysMs: [1000] });
    const failure = { stage: 'probe' as const, probeTimeout: true, elapsedMs: 15_000 };
    execute.mockResolvedValue({ kind: 'transient-failure', failure });

    await vi.advanceTimersByTimeAsync(1100);
    expect(execute).toHaveBeenCalledTimes(2);

    const failed = records.filter(record => record.message === 'Wake-up failed');
    expect(failed.map(record => record.fields)).toMatchObject([
      { chatId: 'chat', stage: 'probe', transient: true, attempt: 1, elapsedMs: 15_000, probeTimeout: true, latestExternalMs: 1000, willRetry: true },
      { stage: 'probe', transient: true, attempt: 2, willRetry: false },
    ]);
    const abandoned = records.filter(record => record.message.startsWith('Wake-up abandoned'));
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({
      level: 'warn',
      message: 'Wake-up abandoned',
      fields: { chatId: 'chat', stage: 'probe', attempt: 2, latestExternalMs: 1000, reason: 'retries-exhausted' },
    });
    scheduler.dispose();
  });

  it('logs a permanent failure as abandoned at once, and a failed rearm as a single error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { log, records } = recordingLog();
    const { scheduler, execute } = makeScheduler({ log });
    execute.mockResolvedValue({ kind: 'failure', failure: { stage: 'primary', probeTimeout: false, elapsedMs: 40 } });

    await vi.advanceTimersByTimeAsync(100);
    expect(records.filter(record => record.level === 'warn' && record.message === 'Wake-up abandoned')).toHaveLength(1);
    expect(records.find(record => record.message === 'Wake-up abandoned')!.fields).toMatchObject({ reason: 'permanent-failure', stage: 'primary' });

    scheduler.rearmFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(records.filter(record => record.level === 'error')).toHaveLength(1);
    expect(records.filter(record => record.message === 'Wake-up abandoned')).toHaveLength(1);
    scheduler.dispose();
  });
});

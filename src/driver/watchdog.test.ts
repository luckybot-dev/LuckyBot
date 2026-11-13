import type { Logger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerStatus } from './scheduler';
import { createWakeupHealth } from './wakeup-health';
import { createWatchdog } from './watchdog';
import type { WatchdogChat } from './watchdog';

const config = { enabled: true, intervalSec: 60, rearmAfterSec: 600, failureStreakThreshold: 3, summaryIntervalSec: 900 };

const recordingLog = () => {
  const records: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const log = {
    withFields: (fields: Record<string, unknown>) => {
      const at = (level: string) => (message: string) => { records.push({ level, message, fields }); };
      return { debug: at('debug'), log: at('log'), warn: at('warn'), error: at('error'), withError: () => ({ error: at('error') }) };
    },
    withError: () => ({ withFields: () => ({ error: () => {} }) }),
  } as unknown as Logger;
  return { log, records };
};

const makeChat = (overrides: {
  status?: () => SchedulerStatus;
  rearmFailed?: () => boolean;
  compactionFailures?: () => number;
  memoryFailures?: () => number;
} = {}) => {
  const health = createWakeupHealth();
  const rearmFailed = vi.fn(overrides.rearmFailed ?? (() => true));
  const chat: WatchdogChat = {
    chatId: 'chat',
    scheduler: {
      status: overrides.status ?? (() => ({ busy: false, failure: null })),
      rearmFailed,
    },
    health,
    compactionFailures: overrides.compactionFailures ?? (() => 0),
    memoryFailures: overrides.memoryFailures ?? (() => 0),
  };
  return { chat, health, rearmFailed };
};

const failed = (sinceMs: number, extra: Partial<NonNullable<SchedulerStatus['failure']>> = {}): SchedulerStatus => ({
  busy: false,
  failure: { sinceMs, rearmed: false, rearmable: true, ...extra },
});

describe('createWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rearms only after the failure is old enough, and logs it', () => {
    const { log, records } = recordingLog();
    const { chat, rearmFailed } = makeChat({ status: () => failed(1_000) });
    let now = 1_000 + 599_000;
    const watchdog = createWatchdog({ config, chats: () => [chat], now: () => now, log });

    watchdog.tick();
    expect(rearmFailed).not.toHaveBeenCalled();
    now += 1_000;
    watchdog.tick();
    expect(rearmFailed).toHaveBeenCalledOnce();
    expect(records.filter(record => record.message === 'Watchdog: rearming an abandoned wake-up')).toMatchObject([
      { level: 'warn', fields: { chatId: 'chat', stuckMs: 600_000 } },
    ]);
  });

  it.each([
    ['already rearmed', { rearmed: true }],
    ['nothing owed', { rearmable: false }],
  ])('does not rearm a failure that is %s', (_name, extra) => {
    const { log } = recordingLog();
    const { chat, rearmFailed } = makeChat({ status: () => failed(0, extra) });
    createWatchdog({ config, chats: () => [chat], now: () => 10_000_000, log }).tick();
    expect(rearmFailed).not.toHaveBeenCalled();
  });

  it('does not log a rearm when the scheduler refuses it', () => {
    const { log, records } = recordingLog();
    const { chat, rearmFailed } = makeChat({ status: () => failed(0), rearmFailed: () => false });
    createWatchdog({ config, chats: () => [chat], now: () => 10_000_000, log }).tick();
    expect(rearmFailed).toHaveBeenCalledOnce();
    expect(records).toHaveLength(0);
  });

  it('warns once per compaction or memory failure streak and re-arms after recovery', () => {
    const { log, records } = recordingLog();
    let compaction = 2;
    const memory = 5;
    const { chat } = makeChat({ compactionFailures: () => compaction, memoryFailures: () => memory });
    const watchdog = createWatchdog({ config, chats: () => [chat], now: () => 0, log });
    const warns = () => records.filter(record => record.level === 'warn').map(record => record.message);

    watchdog.tick();
    expect(warns()).toEqual(['Watchdog: memory is failing repeatedly']);
    compaction = 3;
    watchdog.tick();
    watchdog.tick();
    expect(warns()).toEqual(['Watchdog: memory is failing repeatedly', 'Watchdog: compaction is failing repeatedly']);
    compaction = 0;
    watchdog.tick();
    compaction = 4;
    watchdog.tick();
    expect(warns().filter(message => message.includes('compaction'))).toHaveLength(2);
  });

  it('logs a wake-up summary only when something happened since the last one', () => {
    const { log, records } = recordingLog();
    const { chat, health } = makeChat();
    let now = 0;
    const watchdog = createWatchdog({ config, chats: () => [chat], now: () => now, log });
    const summaries = () => records.filter(record => record.message === 'Watchdog: wake-up failures since the last summary');

    watchdog.tick();
    now = 900_000;
    watchdog.tick();
    expect(summaries()).toHaveLength(0);

    health.recordFailure({ stage: 'probe', probeTimeout: true });
    health.recordProbeLatency(15_000);
    health.recordAbandoned();
    now = 1_000_000;
    watchdog.tick();
    expect(summaries()).toHaveLength(0);
    now = 1_800_000;
    watchdog.tick();
    expect(summaries()).toMatchObject([{ fields: { chatId: 'chat', probeTimeouts: 1, abandoned: 1, maxProbeLatencyMs: 15_000 } }]);
    now = 2_700_000;
    watchdog.tick();
    expect(summaries()).toHaveLength(1);
  });

  it('runs one interval, ignores a repeated start, and stops idempotently', () => {
    vi.useFakeTimers();
    const { log } = recordingLog();
    const status = vi.fn(() => ({ busy: false, failure: null }) as SchedulerStatus);
    const { chat } = makeChat({ status });
    const watchdog = createWatchdog({ config, chats: () => [chat], log });

    watchdog.start();
    watchdog.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(180_000);
    expect(status).toHaveBeenCalledTimes(3);

    watchdog.stop();
    watchdog.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(180_000);
    expect(status).toHaveBeenCalledTimes(3);
    watchdog.start();
    expect(vi.getTimerCount()).toBe(1);
    watchdog.stop();
  });

  it('does not start when disabled', () => {
    vi.useFakeTimers();
    const { log } = recordingLog();
    createWatchdog({ config: { ...config, enabled: false }, chats: () => [], log }).start();
    expect(vi.getTimerCount()).toBe(0);
  });
});

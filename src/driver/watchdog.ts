import type { Logger } from '@guiiai/logg';

import type { SchedulerStatus } from './scheduler';
import type { WakeupHealth } from './wakeup-health';
import type { WatchdogConfig } from '../config/config';

// Deterministic checks outside the turn loop. One interval per Driver; it only
// reads state and calls `rearmFailed`, never a model, so it cannot add latency
// to or race a turn (the scheduler refuses a rearm unless it is idle).

export interface WatchdogChat {
  chatId: string;
  scheduler: { status: () => SchedulerStatus; rearmFailed: () => boolean };
  health: WakeupHealth;
  compactionFailures: () => number;
  memoryFailures: () => number;
}

export const createWatchdog = (deps: {
  config: WatchdogConfig;
  chats: () => Iterable<WatchdogChat>;
  now?: () => number;
  log: Logger;
}) => {
  const { config, log } = deps;
  const now = deps.now ?? Date.now;
  let interval: ReturnType<typeof setInterval> | undefined;
  // A streak warns once; it re-arms when the streak drops below the threshold.
  const warnedStreaks = new Set<string>();
  const lastSummaryMs = new Map<string, number>();

  const checkStreak = (chatId: string, kind: 'compaction' | 'memory', failures: number): void => {
    const key = `${kind}:${chatId}`;
    if (failures < config.failureStreakThreshold) {
      warnedStreaks.delete(key);
      return;
    }
    if (warnedStreaks.has(key)) return;
    warnedStreaks.add(key);
    log.withFields({ chatId, consecutiveFailures: failures, threshold: config.failureStreakThreshold })
      .warn(`Watchdog: ${kind} is failing repeatedly`);
  };

  const checkChat = (chat: WatchdogChat, nowMs: number): void => {
    const { failure } = chat.scheduler.status();
    if (failure && !failure.rearmed && failure.rearmable && nowMs - failure.sinceMs >= config.rearmAfterSec * 1000) {
      // rearmFailed re-checks idleness and pending retries itself; false means
      // it lost a race, and the next tick looks again.
      if (chat.scheduler.rearmFailed())
        log.withFields({ chatId: chat.chatId, stuckMs: nowMs - failure.sinceMs })
          .warn('Watchdog: rearming an abandoned wake-up');
    }

    checkStreak(chat.chatId, 'compaction', chat.compactionFailures());
    checkStreak(chat.chatId, 'memory', chat.memoryFailures());

    const lastMs = lastSummaryMs.get(chat.chatId);
    if (lastMs === undefined) {
      lastSummaryMs.set(chat.chatId, nowMs);
    } else if (nowMs - lastMs >= config.summaryIntervalSec * 1000) {
      lastSummaryMs.set(chat.chatId, nowMs);
      const summary = chat.health.takeSummary();
      if (summary) log.withFields({ chatId: chat.chatId, sinceMs: nowMs - lastMs, ...summary }).warn('Watchdog: wake-up failures since the last summary');
    }
  };

  const tick = (): void => {
    const nowMs = now();
    for (const chat of deps.chats()) {
      try {
        checkChat(chat, nowMs);
      } catch (error) {
        // One chat's bad state must not stop the others' checks.
        log.withError(error).withFields({ chatId: chat.chatId }).error('Watchdog check failed');
      }
    }
  };

  return {
    tick,
    start(): void {
      if (interval || !config.enabled) return;
      interval = setInterval(tick, config.intervalSec * 1000);
      // Must never keep the process alive on its own.
      interval.unref();
    },
    stop(): void {
      if (interval) clearInterval(interval);
      interval = undefined;
    },
  };
};

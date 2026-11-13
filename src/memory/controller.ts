import type { Logger } from '@guiiai/logg';
import { effect } from 'alien-signals';

import { MemoryValidationError } from './consolidator';
import type { ConsolidationResult } from './consolidator';
import type { MemoryConfig } from './types';
import type { CompactionSessionMeta } from '../driver/types';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

// Provider and transport failures back off exponentially, like compaction:
// a flaky endpoint must not cost an LLM call per message.
export const MEMORY_RETRY_BASE_MS = 5 * 60_000;
export const MEMORY_RETRY_MAX_MS = 60 * 60_000;
// Consecutive runs whose output failed validation on the same window before the
// window is skipped. A validation failure is deterministic given the window, so
// an unbounded retry would be a permanent stall.
export const MEMORY_MAX_VALIDATION_FAILURES = 3;
// One count query per chat per interval; a message burst costs one query.
export const MEMORY_COUNT_THROTTLE_MS = 30_000;

export const createMemoryController = (deps: {
  chatId: string;
  config: MemoryConfig;
  context: Signal<RenderedContext>;
  compactionMeta: Signal<CompactionSessionMeta | null>;
  blockedUserIds: readonly string[];
  loadCursor: (chatId: string) => number;
  advanceCursor: (chatId: string, cursorMs: number, lastError: string | null) => void;
  recordError: (chatId: string, error: string) => void;
  countHumanMessagesSince: (chatId: string, afterMs: number, blockedUserIds: readonly string[]) => number;
  consolidate: (fromMs: number) => Promise<ConsolidationResult>;
  log: Logger;
}) => {
  let running = false;
  let pendingRecheck = false;
  let pendingForce = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let throttleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCountAtMs = -Infinity;
  let consecutiveFailures = 0;
  let retryAfterMs = 0;
  let validation: { fromMs: number; failures: number } | undefined;

  const clearRetryTimer = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = (): void => {
    if (disposed) return;
    clearRetryTimer();
    if (retryAfterMs <= Date.now()) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      // The compaction flush that was swallowed by the latch is still owed.
      scheduleCheck(pendingForce);
    }, retryAfterMs - Date.now());
  };

  const armThrottle = (ms: number): void => {
    if (throttleTimer || disposed) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = undefined;
      scheduleCheck(false);
    }, ms);
  };

  const check = async (force: boolean): Promise<void> => {
    try {
      // The throttle comes first so a message burst costs neither a count query
      // nor a cursor read per message.
      if (!force) {
        const sinceLast = Date.now() - lastCountAtMs;
        if (sinceLast < MEMORY_COUNT_THROTTLE_MS) {
          armThrottle(MEMORY_COUNT_THROTTLE_MS - sinceLast);
          return;
        }
        lastCountAtMs = Date.now();
        const count = deps.countHumanMessagesSince(deps.chatId, deps.loadCursor(deps.chatId), deps.blockedUserIds);
        if (count < deps.config.triggerMessages) return;
      }

      const cursor = deps.loadCursor(deps.chatId);
      const result = await deps.consolidate(cursor);
      // A run that outlived dispose must not move the cursor: the next start
      // replays its window, which the duplicate rule makes harmless.
      if (disposed) return;
      deps.advanceCursor(deps.chatId, result.endMs, null);
      consecutiveFailures = 0;
      retryAfterMs = 0;
      validation = undefined;
      clearRetryTimer();
      deps.log.withFields({
        chatId: deps.chatId,
        kind: result.kind,
        fromMs: cursor,
        cursorMs: result.endMs,
        humanMessages: result.humanMessages,
        opsApplied: result.opsApplied,
        opsRejected: result.opsRejected,
      }).log('Memory consolidation complete');
    } catch (error) {
      if (disposed) {
        deps.log.withError(error).withFields({ chatId: deps.chatId }).debug('Memory run failed during shutdown');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MemoryValidationError) {
        validation = validation?.fromMs === error.fromMs
          ? { fromMs: error.fromMs, failures: validation.failures + 1 }
          : { fromMs: error.fromMs, failures: 1 };
        if (validation.failures >= MEMORY_MAX_VALIDATION_FAILURES) {
          // The same window keeps producing unusable output; skipping it is the
          // only way memory ever speaks again. The range is logged and stored.
          deps.log.withFields({
            chatId: deps.chatId,
            fromMs: error.fromMs,
            toMs: error.endMs,
            failures: validation.failures,
            lastWhy: error.why,
          }).warn('Skipping a memory window after repeated validation failures; its messages are lost to memory');
          deps.advanceCursor(deps.chatId, error.endMs, `skipped window ${error.fromMs}..${error.endMs}: ${error.why}`);
          consecutiveFailures = 0;
          retryAfterMs = 0;
          validation = undefined;
          clearRetryTimer();
          return;
        }
      }
      consecutiveFailures++;
      retryAfterMs = Date.now() + Math.min(
        MEMORY_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
        MEMORY_RETRY_MAX_MS,
      );
      deps.log.withError(error).withFields({
        chatId: deps.chatId,
        consecutiveFailures,
        retryInMs: retryAfterMs - Date.now(),
      }).error('Memory consolidation failed');
      deps.recordError(deps.chatId, message);
      scheduleRetry();
    }
  };

  const scheduleCheck = (force: boolean): void => {
    if (disposed) return;
    pendingForce ||= force;
    // While latched, triggers are ignored; the armed retry rechecks at expiry.
    if (Date.now() < retryAfterMs) {
      scheduleRetry();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const forced = pendingForce;
      pendingForce = false;
      running = true;
      void check(forced).finally(() => {
        running = false;
        if (!disposed && pendingRecheck) {
          pendingRecheck = false;
          scheduleCheck(false);
        }
      });
    }, 0);
  };

  const request = (force: boolean): void => {
    if (disposed) return;
    if (running) {
      pendingRecheck = true;
      pendingForce ||= force;
      return;
    }
    scheduleCheck(force);
  };

  // Volume trigger: any new rendered context may have crossed the threshold.
  const disposeContextEffect = effect(() => {
    if (deps.context().length === 0) return;
    request(false);
  });

  // Compaction trigger: the messages are about to leave the context. The signal
  // is seeded before subscription and an effect runs once immediately, so the
  // first invocation is not a compaction.
  let initialized = false;
  const disposeCompactionEffect = effect(() => {
    deps.compactionMeta();
    if (!initialized) {
      initialized = true;
      return;
    }
    request(true);
  });

  return {
    // Read-only, for the watchdog; the backoff itself is unchanged.
    consecutiveFailures: (): number => consecutiveFailures,
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (throttleTimer) clearTimeout(throttleTimer);
      clearRetryTimer();
      disposeContextEffect();
      disposeCompactionEffect();
    },
  };
};

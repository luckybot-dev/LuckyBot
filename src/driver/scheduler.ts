import type { Logger } from '@guiiai/logg';
import { computed, effect, signal } from 'alien-signals';

import { latestExternalEventMs, triggerSenderLatestMs } from './context';
import type { DebounceConfig, ProbeActivation } from './types';
import type { WakeupFailureInfo, WakeupHealth } from './wakeup-health';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

// `transient-failure` is a provider timeout, 5xx/429 or network error worth
// retrying on the same context; `failure` is anything else. A transient
// failure after probe activated carries that activation so the retry goes
// straight to primary.
//
// Failures may carry the activation too: probe advances the watermark, so a
// failed primary leaves nothing "unprocessed" and the watchdog needs the
// activation to know the context still owes an answer. `failure` is for logs.
export type WakeupOutcome =
  | { kind: 'done' }
  | { kind: 'failure'; probeActivation?: ProbeActivation; failure?: WakeupFailureInfo }
  | { kind: 'transient-failure'; probeActivation?: ProbeActivation; failure?: WakeupFailureInfo };

export interface WakeupRetry {
  probeActivation?: ProbeActivation;
}

// Backoff before each retry of a transiently failed wake-up. At defaults an
// attempt takes at most ~30 s (15 s probe timeout + 15 s primary deadline,
// plus any in-flight tool), so three attempts and both delays abandon a wake-up
// after ~115 s in the worst case. New input resets the count.
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000];

interface PendingRetry {
  // Latest external receivedAtMs in the failed context. The retry stays live
  // until a newer external segment arrives; compaction, edits, deletes and
  // self-events replace the context array without superseding it.
  latestExternalMs: number;
  // Retries already used, including this one.
  attempt: number;
  atMs: number;
  probeActivation?: ProbeActivation;
  // The run chain started from a watchdog rearm; if it ends abandoned it is
  // not rearmed again.
  fromRearm?: boolean;
}

// The most recent abandoned wake-up, for the watchdog. `context` is what
// `failedContext` was set to.
interface AbandonedWakeup {
  context: RenderedContext;
  atMs: number;
  probeActivation?: ProbeActivation;
  // This failure ended a run that the watchdog had rearmed. Never rearmed again.
  rearmed: boolean;
}

export interface SchedulerStatus {
  // A wake-up is executing or a retry is scheduled; the watchdog never acts.
  busy: boolean;
  // Set while `failedContext` still holds the current context.
  failure: { sinceMs: number; rearmed: boolean; rearmable: boolean } | null;
}

export const createReplyScheduler = (deps: {
  chatId: string;
  debounce: DebounceConfig;
  context: Signal<RenderedContext>;
  lastProcessedMs: Signal<number>;
  lastTurnInterrupted: Signal<boolean>;
  // Set by the scheduler after a permanent failure or exhausted retries; that
  // context is not rerun until it changes.
  failedContext: Signal<RenderedContext | null>;
  // `retry` is set only when rerunning the same context after a transient failure.
  execute: (contextAtStart: RenderedContext, retry?: WakeupRetry) => Promise<WakeupOutcome>;
  onDebounceStateChange: (chatId: string, isDebouncing: boolean) => void;
  retryDelaysMs?: readonly number[];
  health?: WakeupHealth;
  log: Logger;
}) => {
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const running = signal(false);
  const lastTypingMs = signal(0);
  const pendingRetry = signal<PendingRetry | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let windowStartMs: number | undefined;
  let debouncing = false;
  let loggedSuperseded: PendingRetry | undefined;
  let abandoned: AbandonedWakeup | undefined;
  // Context cleared by rearmFailed(); the run that picks it up is a rearm run.
  let rearmedContext: RenderedContext | undefined;

  const setDebouncing = (value: boolean): void => {
    if (debouncing === value) return;
    debouncing = value;
    deps.onDebounceStateChange(deps.chatId, value);
  };

  const needsReply = computed(() => {
    const context = deps.context();
    if (context.length === 0 || context === deps.failedContext()) return false;
    if (deps.lastTurnInterrupted()) return true;
    return latestExternalEventMs(context, deps.lastProcessedMs()) != null;
  });

  const fire = (retry?: PendingRetry): void => {
    timer = undefined;
    windowStartMs = undefined;
    setDebouncing(false);
    const contextAtStart = deps.context();
    const retryAttempt = retry?.attempt ?? 0;
    const fromRearm = retry ? retry.fromRearm === true : rearmedContext === contextAtStart;
    rearmedContext = undefined;
    running(true);
    pendingRetry(null);
    const run = async (): Promise<void> => {
      try {
        const outcome = await deps.execute(contextAtStart, retry && { probeActivation: retry.probeActivation });
        if (outcome.kind === 'done') {
          abandoned = undefined;
          return;
        }
        const delayMs = retryDelaysMs[retryAttempt];
        const willRetry = outcome.kind === 'transient-failure' && delayMs != null;
        const record = {
          chatId: deps.chatId,
          stage: outcome.failure?.stage ?? 'unknown',
          transient: outcome.kind === 'transient-failure',
          attempt: retryAttempt + 1,
          elapsedMs: outcome.failure?.elapsedMs,
          probeTimeout: outcome.failure?.probeTimeout ?? false,
          // receivedAtMs of the newest external segment in the context being
          // processed. Rendered segments carry no message id; this is the
          // ordering key of the archived event.
          latestExternalMs: latestExternalEventMs(contextAtStart, Number.NEGATIVE_INFINITY),
          probeActivated: outcome.probeActivation != null,
        };
        deps.log.withFields({ ...record, willRetry }).warn('Wake-up failed');
        if (willRetry) {
          deps.log.withFields({ chatId: deps.chatId, attempt: retryAttempt + 1, delayMs, probeActivated: outcome.probeActivation != null })
            .log('Retrying wake-up after transient failure');
          pendingRetry({
            latestExternalMs: latestExternalEventMs(contextAtStart, Number.NEGATIVE_INFINITY) ?? Number.NEGATIVE_INFINITY,
            attempt: retryAttempt + 1,
            atMs: Date.now() + delayMs,
            probeActivation: outcome.probeActivation,
            ...(fromRearm ? { fromRearm: true } : {}),
          });
        } else {
          deps.failedContext(contextAtStart);
          abandoned = { context: contextAtStart, atMs: Date.now(), probeActivation: outcome.probeActivation, rearmed: fromRearm };
          deps.health?.recordAbandoned();
          // Distinct from a probe `no_action`: this is the line that says a
          // wake-up was missed.
          if (fromRearm)
            deps.log.withFields({ ...record, reason: 'failed-after-watchdog-rearm' }).error('Wake-up abandoned again after watchdog rearm');
          else
            deps.log.withFields({ ...record, reason: outcome.kind === 'transient-failure' ? 'retries-exhausted' : 'permanent-failure' }).warn('Wake-up abandoned');
        }
      } finally {
        running(false);
      }
    };
    void run();
  };

  const disposeEffect = effect(() => {
    const isRunning = running();
    const typingAt = lastTypingMs();
    const pending = pendingRetry();
    // Liveness is decided by unprocessed external input, not array identity:
    // the retry runs against the current context unless new external input
    // arrived, in which case needsReply schedules a normal debounced wake-up
    // with a fresh retry count instead.
    const superseded = pending != null && latestExternalEventMs(deps.context(), pending.latestExternalMs) != null;
    const retry = superseded ? null : pending;
    if (superseded && loggedSuperseded !== pending) {
      loggedSuperseded = pending;
      deps.log.withFields({ chatId: deps.chatId, attempt: pending.attempt }).debug('Pending retry superseded by new input');
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (isRunning || (!retry && !needsReply())) {
      windowStartMs = undefined;
      setDebouncing(false);
      return;
    }

    const currentTime = Date.now();
    // A failed attempt may already have advanced lastProcessedMs (probe ran,
    // primary failed), so a live retry wakes regardless of needsReply. It is
    // not debounced, and typing does not postpone it.
    if (retry) {
      windowStartMs = undefined;
      setDebouncing(false);
      timer = setTimeout(() => fire(retry), Math.max(0, retry.atMs - currentTime));
      return;
    }

    // New input during a backoff supersedes the retry with a fresh debounced
    // wake-up and retry count.
    windowStartMs ??= currentTime;
    setDebouncing(true);
    const latestTriggerMessageMs = triggerSenderLatestMs(
      deps.context(),
      deps.lastProcessedMs(),
    ) ?? currentTime;
    let fireAtMs = latestTriggerMessageMs + deps.debounce.initialDelayMs;
    if (typingAt > 0)
      fireAtMs = Math.max(fireAtMs, typingAt + deps.debounce.typingExtendMs);
    fireAtMs = Math.min(fireAtMs, windowStartMs + deps.debounce.maxDelayMs);

    timer = setTimeout(() => fire(), Math.max(0, fireAtMs - currentTime));
  });

  // Why a failed context may still owe an answer: unprocessed external input,
  // a persisted open continuation, or a probe that already activated primary.
  const owesAnswer = (context: RenderedContext, failure: AbandonedWakeup): boolean =>
    failure.probeActivation != null
    || deps.lastTurnInterrupted()
    || latestExternalEventMs(context, deps.lastProcessedMs()) != null;

  return {
    // Read-only snapshot for the watchdog.
    status(): SchedulerStatus {
      const failed = deps.failedContext();
      const failure = failed != null && abandoned?.context === failed && deps.context() === failed ? abandoned : null;
      return {
        busy: running() || pendingRetry() != null,
        failure: failure && {
          sinceMs: failure.atMs,
          rearmed: failure.rearmed,
          rearmable: owesAnswer(failed!, failure),
        },
      };
    },
    // Lets the abandoned context run once more with a fresh retry count.
    // Returns false (and changes nothing) unless the scheduler is idle, the
    // failure is still current and unrearmed, and the context still owes an
    // answer. A carried probe activation is reused, since the watermark has
    // already moved past the input it judged.
    rearmFailed(): boolean {
      const failed = deps.failedContext();
      if (running() || pendingRetry() != null || failed == null || deps.context() !== failed) return false;
      if (abandoned?.context !== failed || abandoned.rearmed || !owesAnswer(failed, abandoned)) return false;
      const { probeActivation } = abandoned;
      abandoned = { ...abandoned, rearmed: true };
      rearmedContext = failed;
      if (probeActivation)
        pendingRetry({
          latestExternalMs: latestExternalEventMs(failed, Number.NEGATIVE_INFINITY) ?? Number.NEGATIVE_INFINITY,
          attempt: 0,
          atMs: Date.now(),
          probeActivation,
          fromRearm: true,
        });
      deps.failedContext(null);
      return true;
    },
    notifyTyping(): void {
      lastTypingMs(Date.now());
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      setDebouncing(false);
      disposeEffect();
    },
  };
};

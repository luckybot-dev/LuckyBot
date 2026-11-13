import type { Logger } from '@guiiai/logg';
import { computed, effect } from 'alien-signals';

import { runCompaction, COMPACTION_INPUT_HEADROOM_TOKENS } from './compaction';
import { composeContext, estimateTextTokens, findCompactionCapCursor, findWorkingWindowCursor } from './context';
import type { CompactionSessionMeta, ResolvedChatConfig, TurnResponseV2 } from './types';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

// A failed compaction retries with exponential backoff, so a provider outage or
// a persistently failing window does not burn an LLM call on every new message.
// Reset to zero after a successful compaction.
export const COMPACTION_RETRY_BASE_MS = 5 * 60_000;
export const COMPACTION_RETRY_MAX_MS = 60 * 60_000;

export const createCompactionController = (deps: {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  context: Signal<RenderedContext>;
  compactionMeta: Signal<CompactionSessionMeta | null>;
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext;
  log: Logger;
}) => {
  const cursorMs = computed(() => deps.compactionMeta()?.newCursorMs);
  const summary = computed(() => deps.compactionMeta()?.summary);

  const disposeCursorEffect = effect(() => {
    const cursor = cursorMs();
    if (cursor == null) return;
    deps.context(deps.setCompactCursor(deps.chatId, cursor));
  });

  let running = false;
  let pendingRecheck = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCheckedContext: RenderedContext | null = null;
  let consecutiveFailures = 0;
  let retryAfterMs = 0;

  const clearRetryTimer = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const scheduleRetry = (): void => {
    if (disposed) return;
    clearRetryTimer();
    if (retryAfterMs <= Date.now()) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      scheduleCheck();
    }, retryAfterMs - Date.now());
  };

  const scheduleCheck = (): void => {
    if (disposed) return;
    // While latched, context changes are ignored; the armed retry timer
    // rechecks with the latest context when the backoff expires.
    if (Date.now() < retryAfterMs) {
      scheduleRetry();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      lastCheckedContext = deps.context();
      running = true;
      void (async () => {
        try {
          const cursor = cursorMs();
          const oldCursorMs = cursor ?? 0;
          const compactEndpoint = deps.chatConfig.compaction.model ?? deps.chatConfig.primary.model;
          // The trigger measures the primary request, so it must use the
          // primary model's reasoning stripping, not the compaction model's.
          const primaryModelName = deps.chatConfig.primary.model.model;
          const reasoningReplayTurns = deps.chatConfig.primary.reasoningReplayTurns;
          const turnResponses = await deps.loadTurnResponses(deps.chatId, cursor);
          const composed = composeContext(
            deps.context(),
            turnResponses,
            deps.chatConfig.compaction.maxContextEstTokens,
            primaryModelName,
            undefined,
            reasoningReplayTurns,
          );
          if (!composed || composed.rawEstimatedTokens <= deps.chatConfig.compaction.maxContextEstTokens) return;

          const plannedCursorMs = findWorkingWindowCursor(
            deps.context(),
            turnResponses,
            deps.chatConfig.compaction.workingWindowEstTokens,
            primaryModelName,
            reasoningReplayTurns,
          );
          // The compaction request is capped (trigger + headroom). If the
          // whole [oldCursor, plannedCursor) window does not fit, keep only the
          // oldest prefix that does, so the remainder is summarized next time.
          const windowRc = deps.context().filter(segment =>
            segment.receivedAtMs >= oldCursorMs && segment.receivedAtMs < plannedCursorMs);
          const windowTrs = turnResponses.filter(response =>
            response.requestedAtMs >= oldCursorMs && response.requestedAtMs < plannedCursorMs);
          const inputCap = deps.chatConfig.compaction.maxContextEstTokens + COMPACTION_INPUT_HEADROOM_TOKENS;
          const currentSummary = summary();
          const summaryTokens = currentSummary === undefined
            ? 0
            : estimateTextTokens(`[Conversation summary]\n${currentSummary}`);
          const windowBudget = Math.max(0, inputCap - summaryTokens);
          // Walk forward from the old cursor: if the planned window does not
          // fit the cap, keep only the prefix that does, so the remainder is
          // summarized by the next compaction instead of being skipped.
          const cap = findCompactionCapCursor(
            deps.context(),
            turnResponses,
            oldCursorMs,
            windowBudget,
            primaryModelName,
            reasoningReplayTurns,
          );
          const newCursorMs = cap.cursorMs < plannedCursorMs ? cap.cursorMs : plannedCursorMs;
          if (cap.oversizedFirst)
            deps.log.withFields({
              chatId: deps.chatId,
              oldCursorMs,
              plannedCursorMs,
              capCursorMs: cap.cursorMs,
              inputCap,
              summaryTokens,
              windowTokens: cap.estimatedTokens,
            }).warn('Compaction window first entry exceeds the input cap; including it to make progress');
          else if (cap.cursorMs < plannedCursorMs)
            deps.log.withFields({
              chatId: deps.chatId,
              oldCursorMs,
              plannedCursorMs,
              capCursorMs: cap.cursorMs,
              inputCap,
              summaryTokens,
              windowTokens: cap.estimatedTokens,
            }).warn('Compaction window exceeds the input cap; cursor advances only to the summarized part');
          // The cursor must strictly advance; otherwise the window
          // [oldCursorMs, newCursorMs) is empty and the compaction would only
          // re-summarize the existing summary while burning an LLM call.
          if (newCursorMs <= oldCursorMs) return;
          deps.log.withFields({
            chatId: deps.chatId,
            oldCursorMs,
            newCursorMs,
            rawEstimatedTokens: composed.rawEstimatedTokens,
            triggerAt: deps.chatConfig.compaction.maxContextEstTokens,
            retainBudget: deps.chatConfig.compaction.workingWindowEstTokens,
          }).log('Triggering compaction');

          const meta = await runCompaction({
            apiBaseUrl: compactEndpoint.apiBaseUrl,
            apiKey: compactEndpoint.apiKey,
            model: compactEndpoint.model,
            apiFormat: compactEndpoint.apiFormat,
            timeoutSec: compactEndpoint.timeoutSec,
            extraBody: compactEndpoint.extraBody,
            chatId: deps.chatId,
            rcWindow: windowRc.filter(segment => segment.receivedAtMs < newCursorMs),
            trsWindow: windowTrs.filter(response => response.requestedAtMs < newCursorMs),
            existingSummary: currentSummary,
            oldCursorMs,
            newCursorMs,
            maxContextEstTokens: deps.chatConfig.compaction.maxContextEstTokens,
            reasoningReplayTurns,
            maxImagesAllowed: compactEndpoint.maxImagesAllowed,
            log: deps.log,
          });
          deps.persistCompaction(deps.chatId, meta);
          deps.log.withFields({
            chatId: deps.chatId,
            newCursorMs,
            summaryLength: meta.summary.length,
          }).log('Compaction complete');
          deps.compactionMeta(meta);
          consecutiveFailures = 0;
          retryAfterMs = 0;
          clearRetryTimer();
        } catch (error) {
          consecutiveFailures++;
          retryAfterMs = Date.now() + Math.min(
            COMPACTION_RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
            COMPACTION_RETRY_MAX_MS,
          );
          deps.log.withError(error).withFields({
            chatId: deps.chatId,
            consecutiveFailures,
            retryInMs: retryAfterMs - Date.now(),
          }).error('Compaction failed');
          scheduleRetry();
        } finally {
          running = false;
          if (!disposed && pendingRecheck) {
            pendingRecheck = false;
            scheduleCheck();
          }
        }
      })();
    }, 0);
  };

  const disposeCompactionEffect = effect(() => {
    const context = deps.context();
    if (context.length === 0 || context === lastCheckedContext) return;
    if (running) {
      pendingRecheck = true;
      return;
    }
    scheduleCheck();
  });

  return {
    cursorMs,
    summary,
    // Read-only, for the watchdog; the backoff itself is unchanged.
    consecutiveFailures: (): number => consecutiveFailures,
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearRetryTimer();
      disposeCursorEffect();
      disposeCompactionEffect();
    },
  };
};

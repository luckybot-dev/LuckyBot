import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';

import { createCompactionController } from './compaction-controller';
import { wasToolLoopInterrupted } from './context';
import type { ProbeWindowState } from './context';
import type { DriverPlatform } from './platform';
import { createPrimaryTools } from './primary-tools';
import { createRunner } from './runner';
import { applySceneOverrides, getActiveSceneHint, getActiveSceneNotes, type ActiveScene } from './scenes';
import { createReplyScheduler } from './scheduler';
import type { CahciuaTool } from './tools';
import { isTransientModelError } from './transient-error';
import type { CompactionSessionMeta, DriverConfig, ProbeResponseV2, TurnResponseV2 } from './types';
import { executeWakeup } from './wakeup';
import { createWakeupHealth, isRequestTimeout } from './wakeup-health';
import type { WakeupStage } from './wakeup-health';
import { createWatchdog } from './watchdog';
import type { WatchdogChat } from './watchdog';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import { createChatMemory } from '../memory/chat-memory';
import type { MemoryDeps } from '../memory/deps';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverPlatform } from './platform';
export type { DriverConfig } from './types';
export type { TurnResponseV2, ProbeResponseV2 } from './types';

// Platform capabilities are spread flat into deps (see DriverPlatform).
export const createDriver = (config: DriverConfig, deps: DriverPlatform & {
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  // Newest turn response only. Startup reads it twice (last processed time,
  // open-continuation check); loading the whole table for that exhausts the
  // heap on a long-lived chat.
  loadLastTurnResponse: (chatId: string) => Promise<TurnResponseV2 | null>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext;
  getChatTitle: (chatId: string) => string | undefined;
  runtimeConfig: RuntimeConfig;
  readOldMessages: (chatId: string, messageIds: string[]) => Promise<string> | string;
  // Resolve a rendered message alias (or a canonical id) to the canonical id
  // before any platform call or message existence check. Unknown input is
  // returned unchanged so the normal unknown-id errors still apply.
  resolveMessageId?: (chatId: string, raw: string) => string;
  // Render a canonical id the way the chatlog shows it, for tool results that
  // echo a message id back to the model.
  formatMessageId?: (chatId: string, messageId: string) => string;
  resolveModel: (name: string) => LlmEndpoint;
  // Person memory (backend + DB closures). Absent, or disabled for a chat,
  // leaves that chat's prompts and behaviour exactly as without memory.
  memory?: MemoryDeps;
  // Gated extension hints contributed by enabled plugins for this chat.
  getSystemPromptHints?: (chatId: string) => string[];
  getPluginTools?: (chatId: string) => CahciuaTool[];
  getActiveScenes?: (chatId: string) => ActiveScene[];
  backgroundTask: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    getActiveTasks: (sessionId: string) => ActiveTaskInfo[];
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);
  const isMaintainer = config.isMaintainer ?? (() => false);

  const getLastProcessedTime = async (chatId: string): Promise<number> => {
    const lastTr = await deps.loadLastTurnResponse(chatId);
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr?.requestedAtMs ?? 0, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    notifyTyping: () => void;
    cleanup: () => void;
    watchdog: WatchdogChat;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(0);
    // A persisted requiresFollowUp result keeps the wake-up eligible after restart.
    const lastTRInterrupted = signal(false);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    // `wasToolLoopInterrupted` only inspects the newest response, so wrap the
    // single row rather than loading the table.
    void deps.loadLastTurnResponse(chatId)
      .then(last => lastTRInterrupted(last != null && wasToolLoopInterrupted([last])))
      .catch(error => log.withError(error).withFields({ chatId }).warn('Failed to load the last turn response'));
    const failedRc = signal<RenderedContext | null>(null);

    const compactionMeta = signal<CompactionSessionMeta | null>(
      deps.loadCompaction(chatId),
    );
    // Probe window start persists across wake-ups for prefix-cache stability.
    const probeWindow: ProbeWindowState = { startMs: null };

    const compaction = createCompactionController({
      chatId,
      chatConfig,
      context: rc,
      compactionMeta,
      loadTurnResponses: deps.loadTurnResponses,
      persistCompaction: deps.persistCompaction,
      setCompactCursor: deps.setCompactCursor,
      log,
    });
    const { cursorMs, summary } = compaction;
    const memory = createChatMemory({
      chatId,
      chatConfig,
      deps: deps.memory,
      context: rc,
      compactionMeta,
      log,
    });

    const createTools = () => createPrimaryTools({
      chatId,
      chatConfig,
      runtimeConfig: deps.runtimeConfig,
      sendMessage: deps.sendMessage,
      banSpammer: deps.banSpammer,
      setMessageReaction: deps.setMessageReaction,
      loadMessageAttachments: deps.loadMessageAttachments,
      messageExists: deps.messageExists,
      downloadMessageMedia: deps.downloadMessageMedia,
      supportsOutboundAttachments: deps.supportsOutboundAttachments,
      readOldMessages: deps.readOldMessages,
      resolveMessageId: id => deps.resolveMessageId?.(chatId, id) ?? id,
      formatMessageId: id => deps.formatMessageId?.(chatId, id) ?? id,
      resolveModel: deps.resolveModel,
      backgroundTask: deps.backgroundTask,
      pluginTools: deps.getPluginTools?.(chatId),
      log,
    });

    const health = createWakeupHealth();

    const scheduler = createReplyScheduler({
      chatId,
      health,
      debounce: chatConfig.debounce,
      context: rc,
      lastProcessedMs,
      lastTurnInterrupted: lastTRInterrupted,
      failedContext: failedRc,
      onDebounceStateChange: deps.onDebounceStateChange,
      log,
      execute: async (contextAtStart, retry) => {
        // Survives a primary failure so the retry need not rerun probe.
        let probeActivation = retry?.probeActivation;
        const startedAtMs = Date.now();
        // Mutated from executeWakeup callbacks; an object so the catch block
        // sees the latest stage rather than a narrowed initial literal.
        const progress: { stage: WakeupStage; probeStartedAtMs?: number } = { stage: 'prepare' };
        try {
          const activeScenes = deps.getActiveScenes?.(chatId) ?? [];
          const effectiveChatConfig = applySceneOverrides(chatConfig, activeScenes);
          const sceneHint = getActiveSceneHint(effectiveChatConfig, activeScenes);
          const sceneNotes = getActiveSceneNotes(activeScenes);
          const runner = createRunner({
            apiBaseUrl: effectiveChatConfig.primary.model.apiBaseUrl,
            apiKey: effectiveChatConfig.primary.model.apiKey,
            model: effectiveChatConfig.primary.model.model,
            apiFormat: effectiveChatConfig.primary.model.apiFormat,
            timeoutSec: effectiveChatConfig.primary.model.timeoutSec,
            extraBody: effectiveChatConfig.primary.model.extraBody,
          });

          await executeWakeup({
            chatId,
            chatConfig: effectiveChatConfig,
            currentChannel: deps.name,
            turnBudget: effectiveChatConfig.primary.turnBudget,
            contextAtStart,
            currentContext: rc,
            cursorMs: cursorMs(),
            summary: summary(),
            loadTurnResponses: deps.loadTurnResponses,
            persistTurnResponse: deps.persistTurnResponse,
            persistProbeResponse: deps.persistProbeResponse,
            getChatTitle: deps.getChatTitle,
            getActiveBackgroundTasks: deps.backgroundTask.getActiveTasks,
            sendTypingAction: deps.sendTypingAction,
            createTools,
            runner,
            getLastProcessedMs: lastProcessedMs,
            setLastProcessedMs: lastProcessedMs,
            isMaintainer,
            probeActivation,
            onProbeActivated: activation => { probeActivation = activation; },
            onStage: next => {
              progress.stage = next;
              if (next === 'probe') progress.probeStartedAtMs = Date.now();
            },
            onProbeComplete: ({ elapsedMs, malformed }) => {
              health.recordProbeLatency(elapsedMs);
              if (malformed) health.recordProbeMalformed();
            },
            probeWindow,
            memoryEnabled: memory.injecting,
            loadMemorySnapshot: memory.loadSnapshot,
            promptHints: deps.getSystemPromptHints?.(chatId),
            sceneHint,
            sceneNotes,
            log,
          });
          return { kind: 'done' };
        } catch (error) {
          const transient = isTransientModelError(error);
          const now = Date.now();
          const failure = {
            stage: progress.stage,
            probeTimeout: progress.stage === 'probe' && isRequestTimeout(error),
            elapsedMs: now - startedAtMs,
          };
          if (progress.stage === 'probe' && progress.probeStartedAtMs != null)
            health.recordProbeLatency(now - progress.probeStartedAtMs);
          health.recordFailure(failure);
          log.withError(error).withFields({ chatId, transient, ...failure }).error('LLM call failed');
          return { kind: transient ? 'transient-failure' : 'failure', probeActivation, failure };
        } finally {
          try {
            const responses = await deps.loadTurnResponses(chatId, cursorMs());
            lastTRInterrupted(wasToolLoopInterrupted(responses));
          } catch (error) {
            log.withError(error).withFields({ chatId }).warn('Failed to refresh lastTRInterrupted');
          }
        }
      },
    });

    const cleanup = () => {
      scheduler.dispose();
      compaction.dispose();
      memory.dispose();
    };

    const entry = {
      rc,
      notifyTyping: scheduler.notifyTyping,
      cleanup,
      watchdog: {
        chatId,
        scheduler,
        health,
        compactionFailures: compaction.consecutiveFailures,
        memoryFailures: memory.consecutiveFailures,
      },
    };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const handleTyping = (chatId: string) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).notifyTyping();
  };

  const watchdog = config.watchdog
    ? createWatchdog({
        config: config.watchdog,
        *chats() {
          for (const scope of chatScopes.values()) yield scope.watchdog;
        },
        log: log.withContext('watchdog'),
      })
    : undefined;

  // Called by startup once input is active; stop() also stops it.
  const start = () => {
    watchdog?.start();
  };

  const stop = () => {
    watchdog?.stop();
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  // In-memory wake-up failure counters; undefined until the chat has seen input.
  const wakeupCounters = (chatId: string) => chatScopes.get(chatId)?.watchdog.health.counters();

  return { handleEvent, handleTyping, start, stop, wakeupCounters };
};

import type { Logger } from '@guiiai/logg';

import { runConsolidation } from './consolidator';
import { createMemoryController } from './controller';
import type { MemoryDeps } from './deps';
import { createMemorySnapshotLoader } from './injection';
import type { MemorySnapshot } from './injection';
import type { ResolvedChatConfig } from '../config/config';
import type { CompactionSessionMeta } from '../driver/types';
import type { RenderedContext } from '../rendering/types';

type Signal<T> = {
  (): T;
  (value: T): void;
};

export interface ChatMemory {
  // Prompts carry notes (enabled and inject); gates the system-prompt paragraph.
  injecting: boolean;
  // Read once per wake-up; absent when nothing is injected.
  loadSnapshot?: (context: RenderedContext) => MemorySnapshot | null;
  // Consecutive failed consolidations; 0 when memory is disabled.
  consecutiveFailures: () => number;
  dispose: () => void;
}

/**
 * Per-chat person memory: the consolidation controller (writes cards) and the
 * snapshot loader (reads them into prompts). With memory disabled for the chat
 * nothing is created and nothing reads the memory directory.
 */
export const createChatMemory = (params: {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  deps: MemoryDeps | undefined;
  context: Signal<RenderedContext>;
  compactionMeta: Signal<CompactionSessionMeta | null>;
  log: Logger;
}): ChatMemory => {
  const { chatId, chatConfig, deps, log } = params;
  const config = chatConfig.memory;
  if (!deps || !config.enabled) return { injecting: false, consecutiveFailures: () => 0, dispose: () => {} };

  const blockedUserIds = new Set(chatConfig.blockedUserIds);
  const endpoint = config.model ?? chatConfig.compaction.model ?? chatConfig.primary.model;
  const memoryLog = log.withContext('memory');
  const controller = createMemoryController({
    chatId,
    config,
    context: params.context,
    compactionMeta: params.compactionMeta,
    blockedUserIds: chatConfig.blockedUserIds,
    loadCursor: deps.loadCursor,
    advanceCursor: deps.advanceCursor,
    recordError: deps.recordError,
    countHumanMessagesSince: deps.countHumanMessagesSince,
    consolidate: async fromMs => await runConsolidation({
      chatId,
      fromMs,
      config,
      endpoint,
      blockedUserIds,
      deps,
      log: memoryLog,
    }),
    log: memoryLog,
  });

  return {
    injecting: config.inject,
    ...(config.inject
      ? { loadSnapshot: createMemorySnapshotLoader({ chatId, config, backend: deps.backend, blockedUserIds, log: memoryLog }) }
      : {}),
    consecutiveFailures: controller.consecutiveFailures,
    dispose: controller.dispose,
  };
};

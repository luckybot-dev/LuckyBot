import { createBackgroundTaskManager } from '../../background-task/manager';
import { shellTaskFactory } from '../../background-task/shell';
import { resolveChatConfig, resolveModel } from '../../config/config';
import {
  loadCompaction,
  loadEvents,
  loadEventsByMessageIds,
  loadEventsWithId,
  loadImageAltTextByHash,
  loadLastProbeTime,
  loadLastTurnResponse,
  loadLatestMessageContent,
  loadMessageAttachments,
  loadMessageIds,
  loadTurnResponses,
  messageExists,
  persistCompaction,
  persistEvent,
  persistMessage,
  persistMessageDelete,
  persistMessageEdit,
  persistProbeResponse,
  persistTurnResponse,
  updateEventAttachments,
} from '../../db';
import { findModerationSender, loadModerationMessageIds } from '../../db/moderation';
import { createDriver } from '../../driver';
import { createDriverInputBus } from '../../driver/input-bus';
import { renderOldMessagesXml } from '../../driver/read-old-messages';
import { createEventSink } from '../../event-sink';
import { createMessageIdResolver, messageAlias } from '../../rendering';
import {
  createTelegramDriverHooks,
  createTelegramDriverPlatform,
  createTelegramLiveHandlers,
  createTelegramPostStartupTasks,
} from '../../telegram';
import { createModerationService } from '../../telegram/moderation';
import { createModerationApi } from '../../telegram/moderation-api';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerDriver = ({ get, register }: Registrar): void => {
  register(TOKENS.DRIVER_INPUT_BUS, createDriverInputBus);

  register(TOKENS.EVENT_SINK, () => {
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    return createEventSink({
      configuredChatIds: get(TOKENS.CONFIGURED_CHAT_IDS),
      persistEvent: event => persistEvent(db, event),
      hydrateAltText: get(TOKENS.MEDIA_RUNTIME).hydrateAltText,
      pushPipelineEvent: (chatId, event) => pipeline.pushEvent(chatId, event),
      handleDriverEvent: get(TOKENS.DRIVER_INPUT_BUS).handleEvent,
    });
  });

  register(TOKENS.TELEGRAM_DRIVER_HOOKS, () => {
    return createTelegramDriverHooks({
      manager: get(TOKENS.TELEGRAM_MANAGER),
      runtime: get(TOKENS.RUNTIME_CONFIG),
      botUserId: get(TOKENS.TELEGRAM_CLIENTS).bot.botUserId(),
      eventSink: get(TOKENS.EVENT_SINK),
    });
  });

  register(TOKENS.BACKGROUND_TASK_MANAGER, () => {
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const backgroundConfig = get(TOKENS.BACKGROUND_TASKS_CONFIG);
    const manager = createBackgroundTaskManager({
      db,
      persistEvent: event => persistEvent(db, event),
      pushPipelineEvent: (chatId, event) =>
        get(TOKENS.CONFIGURED_CHAT_IDS).has(chatId) ? pipeline.pushEvent(chatId, event) : [],
      handleDriverEvent: get(TOKENS.DRIVER_INPUT_BUS).handleEvent,
      taskOutputDir: backgroundConfig.outputDir,
      retentionCount: backgroundConfig.retentionCount,
      logger: get(TOKENS.LOGGER),
    });
    manager.registerFactory(shellTaskFactory);
    return manager;
  });

  register(TOKENS.TELEGRAM_DRIVER_PLATFORM, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const bot = get(TOKENS.TELEGRAM_CLIENTS).bot;
    const eventSink = get(TOKENS.EVENT_SINK);
    const moderation = createModerationService({
      api: createModerationApi(bot.raw(), bot.botUserId()),
      findSender: (chatId, messageId) => findModerationSender(db, chatId, messageId),
      loadMessageIds: (chatId, userId) => loadModerationMessageIds(db, chatId, userId),
      botUserId: bot.botUserId(),
      enabledChatIds: new Set(get(TOKENS.CHAT_IDS).filter(chatId => resolveChatConfig(config, chatId).tools.banSpammer)),
      publishDeletions: (chatId, messageIds) => {
        const receivedAtMs = Date.now();
        const utcOffsetMin = -new Date(receivedAtMs).getTimezoneOffset();
        persistMessageDelete(db, { chatId, messageIds, receivedAtMs, utcOffsetMin });
        eventSink.accept({
          type: 'delete',
          chatId,
          messageIds: messageIds.map(String),
          receivedAtMs,
          timestampSec: Math.floor(receivedAtMs / 1000),
          utcOffsetMin,
        }, { notifyDriver: false });
      },
      logger: get(TOKENS.LOGGER),
    });
    return createTelegramDriverPlatform({
      hooks: get(TOKENS.TELEGRAM_DRIVER_HOOKS),
      messageExists: (chatId, messageId) => messageExists(db, chatId, messageId),
      loadMessageAttachments: (chatId, messageId) => loadMessageAttachments(db, chatId, messageId),
      banSpammer: moderation.banSpammer,
    });
  });

  register(TOKENS.DRIVER, () => {
    const config = get(TOKENS.CONFIG);
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const backgroundTasks = get(TOKENS.BACKGROUND_TASK_MANAGER);
    const platform = get(TOKENS.DRIVER_PLATFORM);
    return createDriver({
      chatIds: get(TOKENS.CHAT_IDS),
      resolveChatConfig: id => resolveChatConfig(config, id),
      isMaintainer: get(TOKENS.IS_MAINTAINER),
      watchdog: config.watchdog,
    }, {
      ...platform,
      loadTurnResponses: (chatId, afterMs) => loadTurnResponses(db, chatId, afterMs),
      loadLastTurnResponse: chatId => loadLastTurnResponse(db, chatId),
      persistTurnResponse: (chatId, response) => persistTurnResponse(db, chatId, response),
      persistProbeResponse: (chatId, response) => persistProbeResponse(db, chatId, response),
      loadCompaction: chatId => loadCompaction(db, chatId),
      loadLastProbeTime: chatId => loadLastProbeTime(db, chatId),
      persistCompaction: (chatId, meta) => persistCompaction(db, chatId, meta),
      setCompactCursor: (chatId, cursorMs) => {
        const context = pipeline.setCompactCursor(chatId, cursorMs);
        if (!context) throw new Error(`Cannot compact non-resident chat ${chatId}`);
        return context;
      },
      getChatTitle: chatId => {
        const context = pipeline.getIC(chatId);
        if (!context) throw new Error(`Missing Pipeline context for chat ${chatId}`);
        return context.chatTitle;
      },
      runtimeConfig: get(TOKENS.RUNTIME_CONFIG),
      readOldMessages: (chatId, messageIds) =>
        renderOldMessagesXml(chatId, loadEventsByMessageIds(db, chatId, messageIds), pipeline.getRenderParams(chatId)),
      getSystemPromptHints: chatId => get(TOKENS.PLUGIN_HOST).getSystemPromptHints(chatId),
      getPluginTools: chatId => get(TOKENS.PLUGIN_HOST).getTools(chatId),
      getActiveScenes: chatId => get(TOKENS.PLUGIN_HOST).getActiveScenes(chatId),
      // Tool inputs may carry a rendered alias instead of the canonical id.
      // Aliases resolve through the live context first; a miss falls back to a
      // narrow message-id scan of persisted history, so reading or reacting to
      // a message the context no longer holds keeps working. Non-aliases and
      // platforms without aliasing (Telegram) never scan anything.
      resolveMessageId: createMessageIdResolver({
        aliasingEnabled: chatId => pipeline.getRenderParams(chatId).aliasMessageIds === true,
        context: chatId => pipeline.getIC(chatId),
        persistedMessageIds: chatId => loadMessageIds(db, chatId),
      }),
      // Tool results echo the id the chatlog shows, so the model stays consistent.
      formatMessageId: (chatId, messageId) =>
        pipeline.getRenderParams(chatId).aliasMessageIds === true
          ? messageAlias(chatId, messageId)
          : messageId,
      resolveModel: name => resolveModel(config, name),
      memory: get(TOKENS.MEMORY_DEPS),
      backgroundTask: {
        startTask: (typeName, sessionId, params, intention, timeoutMs) =>
          backgroundTasks.startTask(typeName, sessionId, params, intention, timeoutMs),
        killTask: taskId => backgroundTasks.killTask(taskId, 'tool_call'),
        getActiveTasks: sessionId => backgroundTasks.getActiveTasks(sessionId),
        readTaskOutput: (taskId, offset, limit) => backgroundTasks.readTaskOutput(taskId, offset, limit),
      },
      logger: get(TOKENS.LOGGER),
    });
  });

  register(TOKENS.TELEGRAM_LIVE_HANDLERS, () => {
    const db = get(TOKENS.DB);
    return createTelegramLiveHandlers({
      manager: get(TOKENS.TELEGRAM_MANAGER),
      eventSink: get(TOKENS.EVENT_SINK),
      messageStore: {
        loadLatestMessageContent: (chatId, messageId) => loadLatestMessageContent(db, chatId, messageId),
        persistMessage: message => persistMessage(db, message),
        persistMessageEdit: edit => persistMessageEdit(db, edit),
        persistMessageDelete: deletion => persistMessageDelete(db, deletion),
      },
      handleTyping: get(TOKENS.DRIVER_INPUT_BUS).handleTyping,
      logger: get(TOKENS.LOGGER),
    });
  });

  register(TOKENS.TELEGRAM_POST_STARTUP_TASKS, () => {
    const db = get(TOKENS.DB);
    const pipeline = get(TOKENS.PIPELINE);
    const media = get(TOKENS.MEDIA_RUNTIME);
    return createTelegramPostStartupTasks({
      manager: get(TOKENS.TELEGRAM_MANAGER),
      animationResolvers: media.animationResolvers,
      customEmojiResolvers: media.customEmojiResolvers,
      animationMaxFrames: media.animationMaxFrames,
      hasAltText: hash => loadImageAltTextByHash(db, hash) != null,
      loadCompaction: chatId => loadCompaction(db, chatId),
      loadEvents: (chatId, afterMs) => loadEvents(db, chatId, afterMs),
      loadEventsWithId: (chatId, afterMs) => loadEventsWithId(db, chatId, afterMs),
      updateEventAttachments: (eventId, attachments) => updateEventAttachments(db, eventId, attachments),
      hydrateAltText: media.hydrateAltText,
      replayChat: (chatId, events) => pipeline.replayChat(chatId, events),
      logger: get(TOKENS.LOGGER),
    });
  });
};

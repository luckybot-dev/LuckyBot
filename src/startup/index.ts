import { contentToPlainText } from '../adaptation/content';
import { findChatsWithUnreachableShellGate } from '../config/config';
import { buildContainer } from '../container';
import { TOKENS } from '../container/tokens';
import { loadCompaction, loadEventsWithId, loadKnownChatIds, migrateV1ToV2 } from '../db';
import { selectStartupReplayChatIds } from './chat-selection';
import { pruneRetainedHistory } from './retention';

export const startApp = async (): Promise<void> => {
  const container = buildContainer();
  const logger = container.get(TOKENS.LOGGER);
  const db = container.get(TOKENS.DB);
  try {
    await migrateV1ToV2(db, logger);
    // Pipeline rendering needs the bot identity before cold replay.
    await container.get(TOKENS.PLATFORM_IDENTITY).prepare();
  } catch (error) {
    db.$client.close();
    try {
      await container.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Database migration and container disposal failed');
    }
    throw error;
  }

  const chatIds = container.get(TOKENS.CHAT_IDS);
  const media = container.get(TOKENS.MEDIA_RUNTIME);
  const pipeline = container.get(TOKENS.PIPELINE);
  const platform = container.get(TOKENS.PLATFORM_RUNTIME);
  const driver = container.get(TOKENS.DRIVER);
  const driverInput = container.get(TOKENS.DRIVER_INPUT_BUS);
  const backgroundTasks = container.get(TOKENS.BACKGROUND_TASK_MANAGER);
  const pluginHost = container.get(TOKENS.PLUGIN_HOST);

  for (const chatId of findChatsWithUnreachableShellGate(container.get(TOKENS.CONFIG)))
    logger.withFields({ chatId }).warn('tools.bash is enabled and maintainer-gated, but no maintainers are configured; shell tools will never be exposed in this chat');

  let platformStartAttempted = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      logger.log('Shutting down...');
      driverInput.deactivate();
      const errors: unknown[] = [];
      const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      if (pluginHost.isRunning()) await attempt(pluginHost.stop);
      await attempt(driver.stop);
      await attempt(backgroundTasks.shutdown);
      if (platformStartAttempted) await attempt(platform.stop);
      await attempt(() => {
        db.$client.close();
      });
      await attempt(container.dispose);
      if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
    })();
    return stopPromise;
  };

  const handleSignal = (): void => {
    void stop()
      .then(() => process.exit(0))
      .catch(error => {
        logger.withError(error).error('Shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    const knownChatIds = loadKnownChatIds(db);
    const replayChatIds = selectStartupReplayChatIds(knownChatIds, chatIds);
    logger.withFields({
      knownSessions: knownChatIds.length,
      replaySessions: replayChatIds.length,
    }).log('Startup chat selection');

    // Retention runs before replay and before any wake-up: it only deletes rows
    // older than the compaction cursor, and replay already starts at that
    // cursor, so nothing below can miss what was removed.
    pruneRetainedHistory(db, container.get(TOKENS.CONFIG), replayChatIds, logger);

    for (const chatId of replayChatIds) {
      const compaction = loadCompaction(db, chatId);
      if (compaction) pipeline.setCompactCursor(chatId, compaction.newCursorMs);
      const events = loadEventsWithId(db, chatId, compaction?.newCursorMs).map(({ event }) => event);
      const imageResolver = media.imageResolvers.get(chatId);
      if (imageResolver) {
        await Promise.all(events.flatMap(event =>
          (event.type === 'message' || event.type === 'edit') && event.attachments.length > 0
            ? [imageResolver.hydrateCanonicalAttachments(
                event.attachments,
                contentToPlainText(event.content),
              )]
            : []));
      }
      for (const event of events) media.hydrateAltText(event);
      pipeline.replayChat(chatId, events);
    }
    logger.withFields({ sessions: pipeline.getRenderedChats().length }).log('Cold start complete');

    driverInput.attach(driver);
    platform.startIngress();
    platformStartAttempted = true;
    await platform.start();
    driverInput.activate();
    driver.start();
    backgroundTasks.recoverTasks();
    await pluginHost.start();

    for (const [chatId, context] of pipeline.getRenderedChats())
      driverInput.handleEvent(chatId, context);

    logger.log('Cahciua is running');
    await platform.runPostStartup();
  } catch (error) {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    try {
      await stop();
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], 'Application startup and rollback failed');
    }
    throw error;
  }
};

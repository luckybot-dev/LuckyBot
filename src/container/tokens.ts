import type { Logger } from '@guiiai/logg';

import type { createBackgroundTaskManager } from '../background-task/manager';
import type { PluginToolTasks } from '../background-task/plugin-tool';
import type { BackgroundTasksConfig, Config, RuntimeConfig } from '../config/config';
import type { DB } from '../db/client';
import type { createDriver, DriverPlatform } from '../driver';
import type { DriverInputBus } from '../driver/input-bus';
import type { EventSink } from '../event-sink';
import type { FeishuBotIdentity, FeishuIngress, FeishuSdk } from '../feishu';
import type { createFeishuUserNames } from '../feishu/user-names';
import type { MediaRuntime } from '../media/runtime';
import type { MemoryDeps } from '../memory/deps';
import type { MemoryBackend } from '../memory/types';
import type { createPipeline } from '../pipeline';
import type { PluginHost } from '../plugins/host';
import type { PlatformIdentity, PlatformRuntime } from '../startup/platform';
import type { TelegramDriverHooks, TelegramLiveHandlers, TelegramManager, TelegramPostStartupTasks } from '../telegram';
import type { TelegramClients } from '../telegram/manager';

declare const tokenType: unique symbol;

export interface Token<T> {
  readonly symbol: symbol;
  readonly [tokenType]?: (_: T) => T;
}

const token = <T>(name: string): Token<T> => ({ symbol: Symbol(name) });

export const TOKENS = {
  LOGGER: token<Logger>('Logger'),
  CONFIG: token<Config>('Config'),
  RUNTIME_CONFIG: token<RuntimeConfig>('RuntimeConfig'),
  BACKGROUND_TASKS_CONFIG: token<BackgroundTasksConfig>('BackgroundTasksConfig'),
  CHAT_IDS: token<string[]>('ChatIds'),
  CONFIGURED_CHAT_IDS: token<ReadonlySet<string>>('ConfiguredChatIds'),
  MAINTAINERS: token<ReadonlySet<string>>('Maintainers'),
  IS_MAINTAINER: token<(userId: string) => boolean>('IsMaintainer'),
  DB: token<DB>('Database'),
  TELEGRAM_CLIENTS: token<TelegramClients>('TelegramClients'),
  MEDIA_RUNTIME: token<MediaRuntime>('MediaRuntime'),
  TELEGRAM_MANAGER: token<TelegramManager>('TelegramManager'),
  PIPELINE: token<ReturnType<typeof createPipeline>>('Pipeline'),
  MEMORY_BACKEND: token<MemoryBackend>('MemoryBackend'),
  MEMORY_DEPS: token<MemoryDeps>('MemoryDeps'),
  DRIVER_INPUT_BUS: token<DriverInputBus>('DriverInputBus'),
  EVENT_SINK: token<EventSink>('EventSink'),
  TELEGRAM_DRIVER_HOOKS: token<TelegramDriverHooks>('TelegramDriverHooks'),
  TELEGRAM_DRIVER_PLATFORM: token<DriverPlatform>('TelegramDriverPlatform'),
  PLUGIN_TOOL_TASKS: token<PluginToolTasks>('PluginToolTasks'),
  BACKGROUND_TASK_MANAGER: token<ReturnType<typeof createBackgroundTaskManager>>('BackgroundTaskManager'),
  DRIVER: token<ReturnType<typeof createDriver>>('Driver'),
  TELEGRAM_LIVE_HANDLERS: token<TelegramLiveHandlers>('TelegramLiveHandlers'),
  TELEGRAM_POST_STARTUP_TASKS: token<TelegramPostStartupTasks>('TelegramPostStartupTasks'),
  FEISHU_SDK: token<FeishuSdk>('FeishuSdk'),
  FEISHU_BOT_IDENTITY: token<FeishuBotIdentity>('FeishuBotIdentity'),
  FEISHU_INGRESS: token<FeishuIngress>('FeishuIngress'),
  FEISHU_USER_NAMES: token<ReturnType<typeof createFeishuUserNames>>('FeishuUserNames'),
  FEISHU_DRIVER_PLATFORM: token<DriverPlatform>('FeishuDriverPlatform'),
  FEISHU_RUNTIME: token<PlatformRuntime>('FeishuRuntime'),
  TELEGRAM_RUNTIME: token<PlatformRuntime>('TelegramRuntime'),
  PLUGIN_HOST: token<PluginHost>('PluginHost'),
  // Resolve to the implementation selected by `config.platform`.
  PLATFORM_IDENTITY: token<PlatformIdentity>('PlatformIdentity'),
  PLATFORM_RUNTIME: token<PlatformRuntime>('PlatformRuntime'),
  DRIVER_PLATFORM: token<DriverPlatform>('DriverPlatform'),
} as const;

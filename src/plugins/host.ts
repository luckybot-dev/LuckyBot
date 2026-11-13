import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from '@guiiai/logg';
import * as v from 'valibot';

import { createPluginHttpServer, type PluginHttpServer } from './http-server';
import {
  CURRENT_SDK_VERSION,
  type ChatPublishOptions,
  type HttpRoute,
  type PluginCapabilities,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
  type PluginTool,
  type PluginToolResult,
  type PromptHint,
  type RedactionHit,
} from '../../plugins/src/sdk';
import type { PluginToolTasks } from '../background-task/plugin-tool';
import { mergeChatConfig, resolveChatConfig, resolveModel, type Config } from '../config/config';
import { computeParticipationStats } from '../driver/participation-stats';
import type { ActiveScene } from '../driver/scenes';
import { createTool, type CahciuaTool } from '../driver/tools';
import type { ToolResult } from '../driver/tools/types';
import { localTimeNow } from '../driver/wakeup';
import type { EventSink } from '../event-sink';
import { callLlm, type LlmCallConfig } from '../llm/call';
import { getLlmRedactor, installLlmRedactor, type LlmRedactor } from '../llm/redaction';
import { renderEntries } from '../memory/injection';
import type { MemoryBackend } from '../memory/types';
import type { IntermediateContext } from '../projection';
import { rcToXml } from '../rendering';
import type { RenderedContext, RenderParams } from '../rendering';
import type { RuntimePluginEvent } from '../runtime-event';
import type { ConversationEntry, OutputMessage, TextPart } from '../unified-api/types';

export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_message',
  'react',
  'end_turn',
  'bash',
  'kill_task',
  'read_task_output',
  'download_file',
  'read_image',
  'read_old_messages',
  'ban_spammer',
]);

export interface PluginHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getHttpServer(): PluginHttpServer;
  getSystemPromptHints(chatId: string): string[];
  getTools(chatId: string): CahciuaTool[];
  getActiveScenes(chatId: string): ActiveScene[];
}

export interface PluginHostDeps {
  config: Config;
  eventSink: EventSink;
  logger: Logger;
  plugins: readonly PluginDefinition<unknown>[];
  dataDir?: string;
  pipeline?: {
    getRC?: (chatId: string) => RenderedContext | undefined;
    getIC?: (chatId: string) => IntermediateContext | undefined;
    getRenderParams?: (chatId: string) => RenderParams;
  };
  memoryBackend?: MemoryBackend;
  // Narrow handle for tools that declare `background`: the plugin host never
  // sees the task manager, only this closure scoped to plugin-tool tasks.
  backgroundTask?: {
    tasks: PluginToolTasks;
    startTask: (
      typeName: string,
      sessionId: string,
      params: unknown,
      intention: string | undefined,
      timeoutMs: number,
    ) => number;
  };
  callModelOverride?: (
    modelName: string,
    prompt: string | { system?: string; user: string },
    options?: { timeoutSec?: number; dumpId?: string },
  ) => Promise<string>;
}

const wrapLogger = (logger: Logger): PluginLogger => ({
  log: (msg, fields) => logger.withFields(fields ?? {}).log(msg),
  warn: (msg, fields) => logger.withFields(fields ?? {}).warn(msg),
  error: (msg, fields) => logger.withFields(fields ?? {}).error(msg),
  debug: (msg, fields) => logger.withFields(fields ?? {}).debug(msg),
  withFields: fields => wrapLogger(logger.withFields(fields)),
  withError: err => wrapLogger(logger.withError(err)),
});

export const createPluginHost = (deps: PluginHostDeps): PluginHost => {
  const hostLogger = deps.logger.withContext('plugin-host');
  const httpServer = createPluginHttpServer(deps.logger.withContext('plugin-http'));
  const activePlugins = new Map<string, PluginDefinition<unknown>>();
  const activePromptHints = new Map<string, (chatId: string) => PromptHint[] | undefined>();
  // Plugins that contribute `redactText` act on every model request, not per
  // chat, so their prompt hints are rendered for every chat too.
  const globalHintPlugins = new Set<string>();
  const redactTexts: Array<(text: string) => string> = [];
  const inspectTexts: Array<(text: string) => RedactionHit[]> = [];
  let installedRedactor: LlmRedactor | undefined;

  interface ActiveSceneState {
    pluginId: string;
    sceneId: string;
    key: string;
    defaultHint?: string;
    idleTimeoutMs: number;
    timer?: NodeJS.Timeout;
    note?: string;
  }

  const activeScenes = new Map<string, Map<string, ActiveSceneState>>();
  let running = false;

  const isPluginEnabled = (pluginId: string): boolean => {
    const rawConf = deps.config.plugins?.[pluginId];
    if (rawConf && typeof rawConf === 'object' && 'enabled' in (rawConf as Record<string, unknown>)) {
      return (rawConf as Record<string, unknown>).enabled !== false;
    }
    return rawConf !== undefined;
  };

  const isPluginEnabledForChat = (chatId: string, pluginId: string): boolean => {
    if (!deps.config.chats[chatId]) return false;
    const merged = mergeChatConfig(deps.config, chatId);
    const pluginConf = merged.plugins?.[pluginId];
    return pluginConf?.enabled === true;
  };

  const createCapabilities = (pluginId: string): PluginCapabilities => {
    const pluginLog = deps.logger.withContext(`plugin:${pluginId}`);
    const dataRoot = resolve(deps.dataDir ?? './data', 'plugins', pluginId);

    const callModel: PluginCapabilities['callModel'] = async (modelName, promptInput, options) => {
      if (deps.callModelOverride) {
        const text = typeof promptInput === 'string' ? promptInput : promptInput.user;
        return await deps.callModelOverride(modelName, text, options);
      }

      const endpoint = resolveModel(deps.config, modelName);
      const timeoutSec = options?.timeoutSec ?? endpoint.timeoutSec ?? 15;
      const llmConfig: LlmCallConfig = {
        apiBaseUrl: endpoint.apiBaseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        apiFormat: endpoint.apiFormat,
        extraBody: endpoint.extraBody,
        timeoutSec,
      };

      const system = typeof promptInput === 'object' && promptInput.system ? promptInput.system : '';
      const userText = typeof promptInput === 'string' ? promptInput : promptInput.user;

      const entries: ConversationEntry[] = [
        {
          kind: 'message',
          role: 'user',
          parts: [{ kind: 'text', text: userText }],
        },
      ];

      const result = await callLlm(
        llmConfig,
        entries,
        system,
        undefined,
        {
          log: pluginLog,
          label: `plugin:${pluginId}`,
          dumpId: options?.dumpId,
        },
      );

      return result.entries
        .filter((e): e is OutputMessage => e.kind === 'message' && e.role === 'assistant')
        .flatMap(e => e.parts)
        .filter((p): p is TextPart => p.kind === 'text')
        .map(p => p.text)
        .join('\n');
    };

    const route = (r: HttpRoute) => {
      httpServer.registerRoute(r);
    };

    const publish = (chatId: string, options: ChatPublishOptions) => {
      if (!isPluginEnabledForChat(chatId, pluginId)) {
        hostLogger.withFields({ chatId, pluginId }).debug('Chat publication dropped: plugin not enabled for chat');
        return;
      }

      const now = Date.now();
      const runtimeEvent: RuntimePluginEvent = {
        type: 'runtime',
        kind: 'plugin_event',
        chatId,
        receivedAtMs: now,
        timestampSec: Math.floor(now / 1000),
        utcOffsetMin: -new Date().getTimezoneOffset(),
        plugin: pluginId,
        text: options.text,
      };

      deps.eventSink.accept(runtimeEvent, {
        notifyDriver: options.wake ?? false,
      });

      // Refresh inactivity timeout for any active scenes of this plugin in this chat
      const chatScenes = activeScenes.get(chatId);
      if (chatScenes) {
        for (const [key, sceneState] of chatScenes) {
          if (sceneState.pluginId === pluginId) {
            if (sceneState.timer) clearTimeout(sceneState.timer);
            const exitScene = () => {
              const scenes = activeScenes.get(chatId);
              if (!scenes) return;
              const current = scenes.get(key);
              if (current?.timer) clearTimeout(current.timer);
              scenes.delete(key);
              if (scenes.size === 0) activeScenes.delete(chatId);
            };
            const timer = setTimeout(() => {
              exitScene();
            }, sceneState.idleTimeoutMs);
            if (timer.unref) timer.unref();
            sceneState.timer = timer;
          }
        }
      }
    };

    const enter = (chatId: string, sceneId: string) => {
      if (!isPluginEnabledForChat(chatId, pluginId)) {
        hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene enter dropped: plugin not enabled for chat');
        return;
      }

      const pluginDef = deps.plugins.find(p => p.id === pluginId);
      const sceneDef = pluginDef?.contributes?.scenes?.find(s => s.id === sceneId);
      if (!sceneDef) {
        hostLogger.withFields({ pluginId, sceneId }).warn('Scene enter failed: scene not declared by plugin');
        return;
      }

      const key = `${pluginId}.${sceneId}`;
      let chatScenes = activeScenes.get(chatId);
      if (!chatScenes) {
        chatScenes = new Map();
        activeScenes.set(chatId, chatScenes);
      }

      const existing = chatScenes.get(key);
      if (existing?.timer) {
        clearTimeout(existing.timer);
      }

      const idleTimeoutMs = sceneDef.idleTimeoutMs ?? 600_000;

      const exitScene = () => {
        const scenes = activeScenes.get(chatId);
        if (!scenes) return;
        const current = scenes.get(key);
        if (current?.timer) clearTimeout(current.timer);
        scenes.delete(key);
        if (scenes.size === 0) activeScenes.delete(chatId);
        hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene exited');
      };

      const timer = setTimeout(() => {
        hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene expired via idle timeout');
        exitScene();
      }, idleTimeoutMs);
      if (timer.unref) timer.unref();

      chatScenes.set(key, {
        pluginId,
        sceneId,
        key,
        defaultHint: sceneDef.hint,
        idleTimeoutMs,
        timer,
      });
      hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene entered');
    };

    const exit = (chatId: string, sceneId: string) => {
      const key = `${pluginId}.${sceneId}`;
      const scenes = activeScenes.get(chatId);
      if (!scenes) return;
      const current = scenes.get(key);
      if (current?.timer) clearTimeout(current.timer);
      scenes.delete(key);
      if (scenes.size === 0) activeScenes.delete(chatId);
      hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene exited manually');
    };

    const note = (chatId: string, sceneId: string, text: string | null) => {
      if (!isPluginEnabledForChat(chatId, pluginId)) {
        hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene note dropped: plugin not enabled for chat');
        return;
      }
      const key = `${pluginId}.${sceneId}`;
      const chatScenes = activeScenes.get(chatId);
      const sceneState = chatScenes?.get(key);
      if (!sceneState) {
        hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene note dropped: scene not active');
        return;
      }
      if (text === null) {
        delete sceneState.note;
      } else {
        sceneState.note = text;
      }
      hostLogger.withFields({ chatId, pluginId, sceneId }).debug('Scene note updated');
    };

    const isEnabledForChat = (chatId: string): boolean => isPluginEnabledForChat(chatId, pluginId);

    const ask: PluginCapabilities['ask'] = async (chatId, options) => {
      if (!isPluginEnabledForChat(chatId, pluginId)) {
        throw new Error(`Plugin "${pluginId}" is not enabled for chat "${chatId}"`);
      }

      if (
        !options ||
        typeof options.question !== 'string' ||
        options.question.trim().length === 0 ||
        !Array.isArray(options.choices) ||
        options.choices.length < 2 ||
        options.choices.length > 5 ||
        options.choices.some(c => typeof c !== 'string' || c.trim().length === 0)
      ) {
        throw new Error('ask requires a question and 2 to 5 non-empty string choices');
      }

      const timeoutMs = Math.min(14000, Math.max(1, options.timeoutMs ?? 10000));
      const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

      const resolved = resolveChatConfig(deps.config, chatId);
      const pluginConf = deps.config.plugins?.[pluginId] as Record<string, unknown> | undefined;
      const askModelName = typeof pluginConf?.askModel === 'string' ? pluginConf.askModel : undefined;
      const endpoint = askModelName ? resolveModel(deps.config, askModelName) : resolved.probe.model;

      const systemParts: string[] = [];
      if (resolved.systemFiles.length > 0) {
        systemParts.push('## Your personality description files');
        for (const file of resolved.systemFiles) {
          systemParts.push(`## ${file.filename}\n\n${file.content}`);
        }
      }
      systemParts.push('Answer as yourself. Pick exactly one of the choices.\nOutput JSON only: {"choice": "...", "reason": "..."}');
      const systemPrompt = systemParts.join('\n\n');

      const timeNow = localTimeNow();
      const rc = deps.pipeline?.getRC?.(chatId) ?? [];
      const stats = computeParticipationStats({ segments: rc, nowMs: Date.now() });

      let selfNotes: string | undefined;
      if (resolved.memory.enabled && deps.memoryBackend) {
        try {
          const selfCard = deps.memoryBackend.readSelf(chatId);
          if (selfCard.entries.length > 0) {
            selfNotes = renderEntries(selfCard.entries, resolved.memory.selfInjectionChars);
          }
        } catch (err) {
          pluginLog.withFields({ chatId, error: err }).debug('Failed to read SELF.md for ask');
        }
      }

      const tailSegments = rc.slice(-30);
      const chatlogXml = tailSegments.length > 0 ? rcToXml(tailSegments) : '';

      const contextBlocks: string[] = [
        `Current time: ${timeNow}`,
        `Participation stats:\n- Recent self messages (10m): ${stats.recentSelfMessages10m}${stats.secondsSinceLastSelfMessage !== undefined ? `\n- Seconds since last self message: ${stats.secondsSinceLastSelfMessage}` : ''}\n- Consecutive bot exchanges: ${stats.consecutiveBotExchanges}`,
      ];
      if (selfNotes) {
        contextBlocks.push(`<memory-self>\n${selfNotes}\n</memory-self>`);
      }
      if (chatlogXml) {
        contextBlocks.push(`<chatlog>\n${chatlogXml}\n</chatlog>`);
      }

      const userPrompt = [
        '## Context',
        contextBlocks.join('\n\n'),
        '## Question',
        options.question,
        '## Choices',
        options.choices.map(c => `- ${c}`).join('\n'),
        'Pick exactly one choice from the list above. Respond with JSON only: {"choice": "...", "reason": "..."}',
      ].join('\n\n');

      const startMs = Date.now();

      const doCall = async (): Promise<string> => {
        if (deps.callModelOverride) {
          return await deps.callModelOverride(
            askModelName ?? endpoint.model,
            { system: systemPrompt, user: userPrompt },
            { timeoutSec, dumpId: `${chatId}.ask` },
          );
        }

        const llmConfig: LlmCallConfig = {
          apiBaseUrl: endpoint.apiBaseUrl,
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          apiFormat: endpoint.apiFormat,
          extraBody: endpoint.extraBody,
          timeoutSec,
        };

        const entries: ConversationEntry[] = [
          {
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: userPrompt }],
          },
        ];

        const result = await callLlm(
          llmConfig,
          entries,
          systemPrompt,
          undefined,
          {
            log: pluginLog,
            label: `plugin:${pluginId}:ask`,
            dumpId: `${chatId}.ask`,
          },
        );

        return result.entries
          .filter((e): e is OutputMessage => e.kind === 'message' && e.role === 'assistant')
          .flatMap(e => e.parts)
          .filter((p): p is TextPart => p.kind === 'text')
          .map(p => p.text)
          .join('\n');
      };

      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`ask timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      });

      let rawText: string;
      try {
        rawText = await Promise.race([doCall(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(stripped);
      } catch {
        const match = stripped.match(/\{[\s\S]*\}/);
        if (match) {
          parsedJson = JSON.parse(match[0]);
        } else {
          throw new Error(`Failed to parse model response as JSON: ${rawText}`);
        }
      }

      if (!parsedJson || typeof parsedJson !== 'object') {
        throw new Error('Model response is not a JSON object');
      }

      const rawChoice = (parsedJson as Record<string, unknown>).choice;
      if (typeof rawChoice !== 'string') {
        throw new Error('Model response missing string "choice" field');
      }

      const trimmedChoice = rawChoice.trim();
      const matchedChoice = options.choices.find(c => c.trim() === trimmedChoice);
      if (!matchedChoice) {
        throw new Error(`Model choice "${trimmedChoice}" is not one of: ${options.choices.join(', ')}`);
      }

      const latencyMs = Date.now() - startMs;
      hostLogger.withFields({ chatId, pluginId, choice: matchedChoice, latencyMs }).debug('ask completed');

      const reason = typeof (parsedJson as Record<string, unknown>).reason === 'string'
        ? ((parsedJson as Record<string, unknown>).reason as string).trim()
        : undefined;

      return {
        choice: matchedChoice,
        ...(reason ? { reason } : {}),
      };
    };

    return {
      callModel,
      ask,
      isEnabledForChat,
      http: { route },
      chat: { publish },
      scene: { enter, exit, note },
      storage: {
        get rootDir() {
          mkdirSync(dataRoot, { recursive: true });
          return dataRoot;
        },
      },
      log: wrapLogger(pluginLog),
      media: {
        send: async (_chatId, media) => {
          throw new Error(`media.send is unsupported in this host: ${media.kind}`);
        },
      },
    };
  };

  const start = async (): Promise<void> => {
    if (running) return;

    const registeredToolNames = new Map<string, string>();

    for (const plugin of deps.plugins) {
      if (plugin.sdkVersion !== CURRENT_SDK_VERSION) {
        throw new Error(
          `Plugin ${plugin.id} requires SDK version ${plugin.sdkVersion}, but host supports ${CURRENT_SDK_VERSION}`,
        );
      }

      if (!isPluginEnabled(plugin.id)) {
        hostLogger.withFields({ pluginId: plugin.id }).debug('Plugin disabled in config');
        continue;
      }

      if (plugin.contributes?.tools) {
        if (Array.isArray(plugin.contributes.tools)) {
          const pluginToolNames = new Set<string>();
          for (const tool of plugin.contributes.tools) {
            if (BUILTIN_TOOL_NAMES.has(tool.name)) {
              throw new Error(`Plugin tool name collision: "${tool.name}" from plugin "${plugin.id}" collides with a built-in tool`);
            }
            const otherPlugin = registeredToolNames.get(tool.name);
            if (otherPlugin && otherPlugin !== plugin.id) {
              throw new Error(`Plugin tool name collision: "${tool.name}" from plugin "${plugin.id}" collides with plugin "${otherPlugin}"`);
            }
            if (pluginToolNames.has(tool.name)) {
              throw new Error(`Duplicate tool name "${tool.name}" in plugin "${plugin.id}"`);
            }
            pluginToolNames.add(tool.name);
            registeredToolNames.set(tool.name, plugin.id);
          }
        } else if (typeof plugin.contributes.tools === 'function') {
          const checkChats = ['default', ...Object.keys(deps.config.chats ?? {}).filter(k => k !== 'default')];
          for (const chatId of checkChats) {
            const merged = deps.config.chats?.[chatId] ? mergeChatConfig(deps.config, chatId) : undefined;
            const chatPluginConfig = merged?.plugins?.[plugin.id];
            const tools = plugin.contributes.tools(chatId, chatPluginConfig);
            if (tools) {
              const chatToolNames = new Set<string>();
              for (const tool of tools) {
                if (BUILTIN_TOOL_NAMES.has(tool.name)) {
                  throw new Error(`Plugin tool name collision: "${tool.name}" from plugin "${plugin.id}" collides with a built-in tool`);
                }
                const otherPlugin = registeredToolNames.get(tool.name);
                if (otherPlugin && otherPlugin !== plugin.id) {
                  throw new Error(`Plugin tool name collision: "${tool.name}" from plugin "${plugin.id}" collides with plugin "${otherPlugin}"`);
                }
                if (chatToolNames.has(tool.name)) {
                  throw new Error(`Duplicate tool name "${tool.name}" in plugin "${plugin.id}"`);
                }
                chatToolNames.add(tool.name);
                registeredToolNames.set(tool.name, plugin.id);
              }
            }
          }
        }
      }

      let rawConfig: unknown = deps.config.plugins?.[plugin.id] ?? {};
      if (plugin.configSchema) {
        const parsed = v.safeParse(plugin.configSchema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, rawConfig);
        if (!parsed.success) {
          throw new Error(`Plugin ${plugin.id} configuration failed validation: ${parsed.issues.map(i => i.message).join('; ')}`);
        }
        rawConfig = parsed.output;
      }

      const capabilities = createCapabilities(plugin.id);
      const ctx: PluginContext<unknown> = {
        config: rawConfig,
        capabilities,
        isEnabledForChat: (chatId: string) => isPluginEnabledForChat(chatId, plugin.id),
      };

      if (plugin.contributes?.httpRoutes) {
        for (const r of plugin.contributes.httpRoutes) {
          httpServer.registerRoute(r);
        }
      }

      if (plugin.contributes?.promptHints) {
        activePromptHints.set(plugin.id, plugin.contributes.promptHints);
      }

      if (plugin.contributes?.redactText) {
        redactTexts.push(plugin.contributes.redactText);
        globalHintPlugins.add(plugin.id);
        if (plugin.contributes.inspectText) inspectTexts.push(plugin.contributes.inspectText);
      }

      await (plugin.setup as (ctx: PluginContext<unknown>) => Promise<void> | void)(ctx);
      activePlugins.set(plugin.id, plugin);
      hostLogger.withFields({ pluginId: plugin.id }).log('Plugin started');
    }

    if (httpServer.hasRoutes()) {
      const serverConf = (deps.config.plugins?.server ?? {}) as { host?: string; port?: number };
      const host = serverConf.host ?? '0.0.0.0';
      const port = serverConf.port ?? 8787;
      await httpServer.start(host, port);
    }

    if (redactTexts.length > 0) {
      const fns = [...redactTexts];
      const inspectors = [...inspectTexts];
      installedRedactor = {
        redact: text => fns.reduce((acc, fn) => fn(acc), text),
        inspect: text => inspectors.flatMap(fn => fn(text)),
      };
      installLlmRedactor(installedRedactor);
    }

    running = true;
  };

  const stop = async (): Promise<void> => {
    if (!running) return;
    const errors: unknown[] = [];

    for (const [id, plugin] of activePlugins) {
      try {
        await plugin.stop?.();
      } catch (err) {
        errors.push(err);
        hostLogger.withError(err).withFields({ pluginId: id }).error('Error stopping plugin');
      }
    }
    activePlugins.clear();
    activePromptHints.clear();
    globalHintPlugins.clear();
    redactTexts.length = 0;
    inspectTexts.length = 0;
    if (installedRedactor && getLlmRedactor() === installedRedactor) installLlmRedactor(undefined);
    installedRedactor = undefined;

    for (const scenes of activeScenes.values()) {
      for (const sceneState of scenes.values()) {
        if (sceneState.timer) clearTimeout(sceneState.timer);
      }
    }
    activeScenes.clear();

    try {
      await httpServer.stop();
    } catch (err) {
      errors.push(err);
      hostLogger.withError(err).error('Error stopping plugin HTTP server');
    }

    running = false;
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Plugin host shutdown failed');
    }
  };

  const getSystemPromptHints = (chatId: string): string[] => {
    const hints: string[] = [];
    for (const [pluginId, hintFn] of activePromptHints) {
      if (!globalHintPlugins.has(pluginId) && !isPluginEnabledForChat(chatId, pluginId)) continue;
      const contributed = hintFn(chatId);
      if (contributed) {
        for (const h of contributed) {
          if (h.placement === 'system') hints.push(h.text);
        }
      }
    }
    return hints;
  };

  const describeCall = (toolName: string, input: unknown): string => {
    const text = `${toolName} ${JSON.stringify(input) ?? ''}`.trim();
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
  };

  // Race the call against `afterMs`. A call that settles in time returns (or
  // throws) exactly like an ordinary tool; a slow one keeps running as a
  // background task whose completion event wakes the chat. The model gets no
  // follow-up here: "checking" plus end_turn is a valid answer, because the
  // result arrives later without the turn waiting for it.
  const executeBackgroundable = async (
    chatId: string,
    pluginId: string,
    tool: PluginTool,
    background: NonNullable<PluginTool['background']>,
    input: unknown,
  ): Promise<ToolResult> => {
    const controller = new AbortController();
    const promise = (async () => await tool.execute(input, controller.signal))();

    type Settled = { ok: true; res: PluginToolResult } | { ok: false; error: unknown };
    const settled: Promise<Settled> = promise.then(
      res => ({ ok: true, res }),
      (error: unknown) => ({ ok: false, error }),
    );

    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<'slow'>(resolveSlow => {
      timer = setTimeout(() => resolveSlow('slow'), background.afterMs);
      timer.unref?.();
    });

    let first: Settled | 'slow';
    try {
      first = await Promise.race([settled, slow]);
    } finally {
      clearTimeout(timer);
    }

    if (first !== 'slow') {
      if (!first.ok) throw first.error;
      return {
        content: first.res.content,
        requiresFollowUp: first.res.requiresFollowUp ?? false,
      };
    }

    if (!deps.backgroundTask) {
      // No task manager (host used standalone): behave like a plain tool.
      const last = await settled;
      if (!last.ok) throw last.error;
      return { content: last.res.content, requiresFollowUp: last.res.requiresFollowUp ?? false };
    }

    const taskId = deps.backgroundTask.tasks.spawn(deps.backgroundTask.startTask, chatId, {
      pluginId,
      toolName: tool.name,
      intention: describeCall(tool.name, input),
      timeoutMs: background.timeoutMs,
      promise: settled.then(outcome => {
        if (!outcome.ok) throw outcome.error;
        return outcome.res.content;
      }),
      abort: reason => controller.abort(new Error(reason)),
    });
    hostLogger.withFields({ chatId, pluginId, tool: tool.name, taskId }).debug('Plugin tool moved to background');

    return {
      content: JSON.stringify({
        background_task_id: taskId,
        message: `\`${tool.name}\` is taking longer than ${Math.round(background.afterMs / 1000)}s and continues in the background (task ${taskId}). Its result will arrive as a runtime event and wake you; you do not need to wait. You may tell the chat you are checking, then end your turn.`,
      }),
      requiresFollowUp: false,
    };
  };

  const getTools = (chatId: string): CahciuaTool[] => {
    const tools: CahciuaTool[] = [];
    for (const [pluginId, plugin] of activePlugins) {
      if (!isPluginEnabledForChat(chatId, pluginId)) continue;
      if (!plugin.contributes?.tools) continue;

      let pluginTools: PluginTool[] | undefined;
      if (Array.isArray(plugin.contributes.tools)) {
        pluginTools = plugin.contributes.tools;
      } else if (typeof plugin.contributes.tools === 'function') {
        const merged = mergeChatConfig(deps.config, chatId);
        const chatPluginConfig = merged.plugins?.[pluginId];
        pluginTools = plugin.contributes.tools(chatId, chatPluginConfig);
      }

      if (pluginTools) {
        for (const t of pluginTools) {
          tools.push(createTool({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            execute: t.background
              ? input => executeBackgroundable(chatId, pluginId, t, t.background!, input)
              : async input => {
                const res = await t.execute(input);
                return {
                  content: res.content,
                  requiresFollowUp: res.requiresFollowUp ?? false,
                };
              },
          }));
        }
      }
    }
    return tools;
  };

  const getActiveScenes = (chatId: string): ActiveScene[] => {
    const scenes = activeScenes.get(chatId);
    if (!scenes) return [];
    return Array.from(scenes.values()).map(s => ({
      pluginId: s.pluginId,
      sceneId: s.sceneId,
      key: s.key,
      defaultHint: s.defaultHint,
      note: s.note,
    }));
  };

  return {
    start,
    stop,
    isRunning: () => running,
    getHttpServer: () => httpServer,
    getSystemPromptHints,
    getTools,
    getActiveScenes,
  };
};

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginHost } from './host';
import { createCronPlugin } from '../../plugins/src/cron';
import { CURRENT_SDK_VERSION, definePlugin, type PluginCapabilities, type PluginDefinition } from '../../plugins/src/sdk';
import type { Config } from '../config/config';
import type { EventSink } from '../event-sink';
import type { PipelineEvent } from '../projection/reduce';

const CHAT_ENABLED = 'oc_plugin_enabled';
const CHAT_DISABLED = 'oc_plugin_disabled';

const makeMockConfig = (pluginOverrides: Record<string, unknown> = {}): Config => ({
  models: {
    probe: {
      apiBaseUrl: 'https://api.example.com',
      apiKey: 'key',
      model: 'test-probe',
      apiFormat: 'openai-chat',
      forceToolChoice: true,
    },
  },
  maintainers: [],
  platform: 'feishu',
  runtime: {
    shell: ['/bin/sh'],
    writeFile: ['/bin/cat'],
    readFile: ['/bin/cat'],
    writeFileSizeLimit: 20000000,
    readFileSizeLimit: 20000000,
  },
  plugins: {
    server: { host: '127.0.0.1', port: 9999 },
    ...pluginOverrides,
  },
  chats: {
    default: {
      primary: { model: 'probe' },
      systemFiles: [],
      sendTypingAction: false,
      blockedUserIds: [],
      debounce: {},
      compaction: {},
      probe: {},
      memory: {},
      participation: {},
      imageToText: {},
      animationToText: {},
      customEmojiToText: {},
      tools: {
        banSpammer: false,
        bash: {
          enabled: false,
          backgroundThresholdSec: 10,
          requireMaintainer: true,
          maintainerWindowSec: 600,
        },
      },
      plugins: {},
    },
    [CHAT_ENABLED]: {
      plugins: {
        test_plugin: { enabled: true },
      },
    },
    [CHAT_DISABLED]: {
      plugins: {
        test_plugin: { enabled: false },
      },
    },
  },
} as unknown as Config);

describe('Core Plugin Host', () => {
  let tmpDataDir: string;
  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'luckybot-plugin-test-'));
  });
  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  const createMockDeps = () => {
    const accepted: Array<{ event: PipelineEvent; options?: { notifyDriver?: boolean } }> = [];
    const eventSink: EventSink = {
      persist: vi.fn(),
      publish: vi.fn(),
      accept: vi.fn((event, options) => {
        accepted.push({ event, options });
        return undefined;
      }),
    };
    const logCalls: Array<{ level: string; msg: string; fields?: any }> = [];
    const logger: any = {
      log: (msg: string, fields?: any) => logCalls.push({ level: 'log', msg, fields }),
      warn: (msg: string, fields?: any) => logCalls.push({ level: 'warn', msg, fields }),
      error: (msg: string, fields?: any) => logCalls.push({ level: 'error', msg, fields }),
      debug: (msg: string, fields?: any) => logCalls.push({ level: 'debug', msg, fields }),
      withFields: () => logger,
      withError: () => logger,
      withContext: () => logger,
    };
    return { eventSink, accepted, logger, logCalls };
  };

  it('fails fast on incompatible sdkVersion', async () => {
    const config = makeMockConfig({ bad_plugin: { enabled: true } });
    const { eventSink, logger } = createMockDeps();

    const badPlugin: PluginDefinition = {
      id: 'bad_plugin',
      sdkVersion: 999,
      setup: vi.fn(),
    };

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [badPlugin],
      dataDir: tmpDataDir,
    });

    await expect(host.start()).rejects.toThrow('Plugin bad_plugin requires SDK version 999');
  });

  it('validates plugin configuration with configSchema', async () => {
    const config = makeMockConfig({
      strict_plugin: { portNumber: 'not-a-number' },
    });
    const { eventSink, logger } = createMockDeps();

    const strictPlugin = definePlugin({
      id: 'strict_plugin',
      sdkVersion: CURRENT_SDK_VERSION,
      configSchema: v.object({
        portNumber: v.number('portNumber must be a number'),
      }),
      setup: vi.fn(),
    });

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [strictPlugin],
      dataDir: tmpDataDir,
    });

    await expect(host.start()).rejects.toThrow('configuration failed validation');
  });

  it('skips disabled plugins without calling setup', async () => {
    const config = makeMockConfig({
      disabled_plugin: { enabled: false },
    });
    const { eventSink, logger } = createMockDeps();
    const setupFn = vi.fn();

    const disabledPlugin = definePlugin({
      id: 'disabled_plugin',
      sdkVersion: CURRENT_SDK_VERSION,
      setup: setupFn,
    });

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [disabledPlugin],
      dataDir: tmpDataDir,
    });

    await host.start();
    expect(setupFn).not.toHaveBeenCalled();
    await host.stop();
  });

  describe('Capabilities', () => {
    it('gates chat.publish by per-chat plugin enablement', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, accepted, logger } = createMockDeps();

      let publishFn: any;
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          publishFn = ctx.capabilities.chat.publish;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      // Enabled chat -> published to eventSink as plugin_event
      await publishFn(CHAT_ENABLED, {
        text: 'Hello group!',
        wake: true,
      });

      expect(accepted.length).toBe(1);
      const first = accepted[0]!;
      expect(first.event.type).toBe('runtime');
      expect((first.event as any).kind).toBe('plugin_event');
      expect((first.event as any).plugin).toBe('test_plugin');
      expect((first.event as any).text).toBe('Hello group!');
      expect(first.options?.notifyDriver).toBe(true);

      // Disabled chat -> dropped silently
      await publishFn(CHAT_DISABLED, {
        text: 'Should not appear',
        wake: true,
      });

      expect(accepted.length).toBe(1); // unchanged

      await host.stop();
    });

    it('enforces plugin identity on chat.publish and prevents spoofing (R1)', async () => {
      const config = makeMockConfig({
        rogue_plugin: { enabled: true },
      });
      // Allow rogue_plugin on CHAT_ENABLED
      (config.chats[CHAT_ENABLED]!.plugins as any).rogue_plugin = { enabled: true };

      const { eventSink, accepted, logger } = createMockDeps();

      let publishFn: any;
      const roguePlugin = definePlugin({
        id: 'rogue_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          publishFn = ctx.capabilities.chat.publish;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [roguePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      await publishFn(CHAT_ENABLED, {
        pluginId: 'admin_plugin',
        text: 'Spoofed announcement',
      } as any);

      expect(accepted.length).toBe(1);
      expect((accepted[0]!.event as any).plugin).toBe('rogue_plugin');
      await host.stop();
    });

    it('media.send throws unsupported error in this runtime', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      let mediaSend: any;
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          mediaSend = ctx.capabilities.media.send;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      await expect(mediaSend('oc_chat', { kind: 'image' })).rejects.toThrow('media.send is unsupported');
      await host.stop();
    });

    it('creates per-plugin storage directory under dataDir', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      let storageRoot = '';
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          storageRoot = ctx.capabilities.storage.rootDir;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      expect(storageRoot).toBe(join(tmpDataDir, 'plugins', 'test_plugin'));
      await host.stop();
    });
  });

  describe('Prompt Hints', () => {
    it('aggregates prompt hints only for chats with the plugin enabled', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          promptHints: chatId => [
            { placement: 'system', text: `Hint for ${chatId}` },
            { placement: 'lateBinding', text: 'Ignored for system prompt' },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      const enabledHints = host.getSystemPromptHints(CHAT_ENABLED);
      expect(enabledHints).toEqual([`Hint for ${CHAT_ENABLED}`]);

      const disabledHints = host.getSystemPromptHints(CHAT_DISABLED);
      expect(disabledHints).toEqual([]);

      await host.stop();
    });
  });

  describe('Cron plugin', () => {
    const overdueFile = (id: string) => JSON.stringify({
      version: 1,
      items: [{
        id,
        kind: 'once',
        spec: '2026-11-13 09:00',
        note: 'check the oven',
        createdAtMs: Date.now() - 7_200_000,
        nextFireAtMs: Date.now() - 600_000,
      }],
    });

    const makeCronConfig = () => {
      const config = makeMockConfig({ cron: {} });
      config.chats[CHAT_ENABLED]!.plugins = { cron: { enabled: true } } as never;
      config.chats[CHAT_DISABLED]!.plugins = { cron: { enabled: false } } as never;
      return config;
    };

    it('renders its hint and tools only for chats where it is enabled', async () => {
      const { eventSink, logger } = createMockDeps();
      const host = createPluginHost({
        config: makeCronConfig(),
        eventSink,
        logger,
        plugins: [createCronPlugin()],
        dataDir: tmpDataDir,
      });
      await host.start();

      const hints = host.getSystemPromptHints(CHAT_ENABLED);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain('right to decline');
      expect(host.getSystemPromptHints(CHAT_DISABLED)).toEqual([]);

      expect(host.getTools(CHAT_ENABLED).map(t => t.name)).toEqual(['schedule_wakeup', 'list_schedules', 'cancel_schedule']);
      expect(host.getTools(CHAT_DISABLED)).toEqual([]);
      await host.stop();
    });

    it('wakes only the enabled chat when an overdue schedule is caught up at startup', async () => {
      vi.useFakeTimers();
      try {
        const root = join(tmpDataDir, 'plugins', 'cron');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, `${CHAT_ENABLED}.json`), overdueFile('on1'));
        writeFileSync(join(root, `${CHAT_DISABLED}.json`), overdueFile('off1'));

        const { eventSink, accepted, logger } = createMockDeps();
        const host = createPluginHost({
          config: makeCronConfig(),
          eventSink,
          logger,
          plugins: [createCronPlugin()],
          dataDir: tmpDataDir,
        });
        await host.start();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(accepted).toHaveLength(1);
        expect(accepted[0]!.options).toEqual({ notifyDriver: true });
        expect(accepted[0]!.event).toMatchObject({ kind: 'plugin_event', chatId: CHAT_ENABLED, plugin: 'cron' });
        expect((accepted[0]!.event as { text: string }).text).toContain('check the oven');
        await host.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('HTTP Server routing', () => {
    it('handles routes registered by plugins with parameter extraction', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          ctx.capabilities.http.route({
            method: 'POST',
            path: '/api/items/:id',
            handler: req => ({
              status: 200,
              body: { receivedId: req.params?.id, receivedBody: req.body },
            }),
          });
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      const server = host.getHttpServer();

      // Test route matching via server handleRequest
      const reqHeaders = { 'content-type': 'application/json' };
      const rawPayload = JSON.stringify({ name: 'gadget' });
      const chunks: string[] = [];
      let statusCode = 0;
      const resHeaders: Record<string, string> = {};

      const req: any = {
        method: 'POST',
        url: '/api/items/42',
        headers: reqHeaders,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(rawPayload);
        },
      };
      const res: any = {
        headersSent: false,
        writeHead: (status: number, headers?: any) => {
          statusCode = status;
          if (headers) Object.assign(resHeaders, headers);
          res.headersSent = true;
        },
        end: (chunk?: string) => {
          if (chunk) chunks.push(chunk);
        },
      };

      await server.handleRequest(req, res);
      expect(statusCode).toBe(200);
      const json = JSON.parse(chunks.join(''));
      expect(json).toEqual({ receivedId: '42', receivedBody: { name: 'gadget' } });

      await host.stop();
    });

    it('returns 500 without leaking error details when a handler throws', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          ctx.capabilities.http.route({
            method: 'GET',
            path: '/crash',
            handler: () => {
              throw new Error('Database password leak: secret123');
            },
          });
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      const server = host.getHttpServer();

      const chunks: string[] = [];
      let statusCode = 0;
      const req: any = {
        method: 'GET',
        url: '/crash',
        headers: {},
        async *[Symbol.asyncIterator]() {},
      };
      const res: any = {
        headersSent: false,
        writeHead: (status: number) => {
          statusCode = status;
          res.headersSent = true;
        },
        end: (chunk?: string) => {
          if (chunk) chunks.push(chunk);
        },
      };

      await server.handleRequest(req, res);
      expect(statusCode).toBe(500);
      const body = chunks.join('');
      expect(body).not.toContain('secret123');
      expect(body).toContain('Internal Server Error');

      await host.stop();
    });
  });

  describe('tools extension point', () => {
    it('fails fast when a plugin tool name collides with a built-in tool', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const collidingPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'send_message',
              description: 'Colliding tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [collidingPlugin],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/collides with a built-in tool/);
    });

    it('fails fast when two plugins contribute the same tool name', async () => {
      const config = makeMockConfig({
        plugin_a: { enabled: true },
        plugin_b: { enabled: true },
      });
      const { eventSink, logger } = createMockDeps();

      const pluginA = definePlugin({
        id: 'plugin_a',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'shared_tool',
              description: 'A tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const pluginB = definePlugin({
        id: 'plugin_b',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'shared_tool',
              description: 'Another tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [pluginA, pluginB],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/collides with plugin "plugin_a"/);
    });

    it('fails fast on duplicate tool name within the same plugin', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const duplicatePlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'dup_tool',
              description: 'First',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
            {
              name: 'dup_tool',
              description: 'Second',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [duplicatePlugin],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/Duplicate tool name "dup_tool"/);
    });

    it('exposes contributed tools only to chats that have the plugin enabled', async () => {
      const config = makeMockConfig({ tool_plugin: { enabled: true } });
      config.chats['oc_enabled'] = {
        plugins: { tool_plugin: { enabled: true } },
      } as any;
      config.chats['oc_disabled'] = {
        plugins: { tool_plugin: { enabled: false } },
      } as any;

      const { eventSink, logger } = createMockDeps();

      const toolPlugin = definePlugin({
        id: 'tool_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: (_chatId: string) => [
            {
              name: 'custom_calc',
              description: 'A calculator tool',
              parameters: {
                type: 'object',
                properties: { num: { type: 'number' } },
                required: ['num'],
              },
              execute: (input: any) => ({
                content: `result: ${input.num * 2}`,
                requiresFollowUp: true,
              }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [toolPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      const enabledTools = host.getTools('oc_enabled');
      expect(enabledTools.map(t => t.name)).toEqual(['custom_calc']);

      const tool = enabledTools[0]!;
      expect(tool.description).toBe('A calculator tool');
      const valid = tool.validate({ num: 21 });
      expect(valid.valid).toBe(true);
      const res = await tool.execute({ num: 21 });
      expect(res).toEqual({ content: 'result: 42', requiresFollowUp: true });

      const disabledTools = host.getTools('oc_disabled');
      expect(disabledTools).toEqual([]);

      await host.stop();
    });
  });

  describe('scenes capability and extension point', () => {
    it('manages scene enter, exit, and idle timeout', async () => {
      vi.useFakeTimers();
      const config = makeMockConfig({ scene_plugin: { enabled: true } });
      config.chats['oc_scene_chat'] = {
        plugins: { scene_plugin: { enabled: true } },
      } as any;

      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const scenePlugin = definePlugin({
        id: 'scene_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          scenes: [
            {
              id: 'arena',
              hint: 'Arena default hint',
              idleTimeoutMs: 5000,
            },
          ],
        },
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [scenePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      expect(capturedCaps).toBeDefined();

      // Enter scene
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      const scenes = host.getActiveScenes('oc_scene_chat');
      expect(scenes).toEqual([
        {
          pluginId: 'scene_plugin',
          sceneId: 'arena',
          key: 'scene_plugin.arena',
          defaultHint: 'Arena default hint',
        },
      ]);

      // Advance time by 4 seconds (timeout is 5000ms) - still active
      vi.advanceTimersByTime(4000);
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);

      // chat.publish from the same plugin refreshes the timeout
      await capturedCaps!.chat.publish('oc_scene_chat', { text: 'Round 2 start' });

      // Advance by another 4 seconds (8s from start, but 4s from refresh) - still active
      vi.advanceTimersByTime(4000);
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);

      // Advance another 2 seconds (6s from refresh) - now expired
      vi.advanceTimersByTime(2000);
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      // Manual enter and exit
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);
      capturedCaps!.scene.exit('oc_scene_chat', 'arena');
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      await host.stop();
      vi.useRealTimers();
    });

    it('drops scene enter if plugin is disabled for the chat', async () => {
      const config = makeMockConfig({ scene_plugin: { enabled: true } });
      config.chats['oc_disabled_chat'] = {
        plugins: { scene_plugin: { enabled: false } },
      } as any;

      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const scenePlugin = definePlugin({
        id: 'scene_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          scenes: [{ id: 'arena', hint: 'Arena' }],
        },
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [scenePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      capturedCaps!.scene.enter('oc_disabled_chat', 'arena');
      expect(host.getActiveScenes('oc_disabled_chat')).toEqual([]);
      await host.stop();
    });

    it('manages scene note lifecycle: sets, updates, clears, and drops appropriately', async () => {
      vi.useFakeTimers();
      const config = makeMockConfig({ scene_plugin: { enabled: true } });
      config.chats['oc_scene_chat'] = {
        plugins: { scene_plugin: { enabled: true } },
      } as any;
      config.chats['oc_disabled_chat'] = {
        plugins: { scene_plugin: { enabled: false } },
      } as any;

      const { eventSink, logger, logCalls } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const scenePlugin = definePlugin({
        id: 'scene_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          scenes: [{ id: 'arena', hint: 'Arena default hint', idleTimeoutMs: 5000 }],
        },
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [scenePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      // 1. Setting note when scene is not active is ignored (debug logged)
      capturedCaps!.scene.note('oc_scene_chat', 'arena', 'private note before active');
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);
      expect(logCalls.some(c => c.level === 'debug' && c.msg.includes('scene not active'))).toBe(true);

      // 2. Setting note when plugin is disabled for chat is dropped
      capturedCaps!.scene.note('oc_disabled_chat', 'arena', 'private note disabled chat');
      expect(logCalls.some(c => c.level === 'debug' && c.msg.includes('plugin not enabled for chat'))).toBe(true);

      // 3. Enter scene and set note
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      capturedCaps!.scene.note('oc_scene_chat', 'arena', 'Target: K | Hand: [Q, K]');
      let scenes = host.getActiveScenes('oc_scene_chat');
      expect(scenes).toHaveLength(1);
      expect(scenes[0]!.note).toBe('Target: K | Hand: [Q, K]');

      // Note is strictly in-memory: eventSink accept/persist was NEVER called for the note
      expect(eventSink.accept).not.toHaveBeenCalled();
      expect(eventSink.persist).not.toHaveBeenCalled();

      // 4. Update note
      capturedCaps!.scene.note('oc_scene_chat', 'arena', 'Target: K | Hand: [Q] | Last: played [K]');
      scenes = host.getActiveScenes('oc_scene_chat');
      expect(scenes[0]!.note).toBe('Target: K | Hand: [Q] | Last: played [K]');

      // 5. Clear note by passing null
      capturedCaps!.scene.note('oc_scene_chat', 'arena', null);
      scenes = host.getActiveScenes('oc_scene_chat');
      expect(scenes[0]!.note).toBeUndefined();

      // 6. Set note again and verify it clears on manual scene exit
      capturedCaps!.scene.note('oc_scene_chat', 'arena', 'temporary note');
      expect(host.getActiveScenes('oc_scene_chat')[0]!.note).toBe('temporary note');
      capturedCaps!.scene.exit('oc_scene_chat', 'arena');
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      // 7. Verify note clears on idle expiry
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      capturedCaps!.scene.note('oc_scene_chat', 'arena', 'note before expiry');
      expect(host.getActiveScenes('oc_scene_chat')[0]!.note).toBe('note before expiry');
      vi.advanceTimersByTime(5000);
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      await host.stop();
      vi.useRealTimers();
    });
  });

  describe('ask capability', () => {
    it('gates by chat: rejects when plugin is not enabled for chat', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const plugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [plugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      expect(capturedCaps!.isEnabledForChat!(CHAT_ENABLED)).toBe(true);
      expect(capturedCaps!.isEnabledForChat!(CHAT_DISABLED)).toBe(false);

      await expect(
        capturedCaps!.ask(CHAT_DISABLED, {
          question: '上不上桌？',
          choices: ['接受', '拒绝'],
        }),
      ).rejects.toThrow('not enabled for chat');

      await host.stop();
    });

    it('validates choices and question strictly', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const plugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [plugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      // <2 choices
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: 'Q?',
          choices: ['A'],
        }),
      ).rejects.toThrow('2 to 5');

      // >5 choices
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: 'Q?',
          choices: ['1', '2', '3', '4', '5', '6'],
        }),
      ).rejects.toThrow('2 to 5');

      // Empty question
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: '',
          choices: ['A', 'B'],
        }),
      ).rejects.toThrow('requires a question');

      await host.stop();
    });

    it('rejects on invalid model response: non-JSON, missing choice, or unknown choice', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;
      let modelReply = 'not json';

      const plugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [plugin],
        dataDir: tmpDataDir,
        callModelOverride: async () => modelReply,
      });

      await host.start();

      // 1. Non-JSON
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: 'Q?',
          choices: ['接受', '拒绝'],
        }),
      ).rejects.toThrow('JSON');

      // 2. Missing choice field
      modelReply = '{"reason": "no choice"}';
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: 'Q?',
          choices: ['接受', '拒绝'],
        }),
      ).rejects.toThrow('missing string "choice"');

      // 3. Unknown choice
      modelReply = '{"choice": "随便", "reason": "whatever"}';
      await expect(
        capturedCaps!.ask(CHAT_ENABLED, {
          question: 'Q?',
          choices: ['接受', '拒绝'],
        }),
      ).rejects.toThrow('not one of');

      await host.stop();
    });

    it('enforces timeout and timeout cap', async () => {
      vi.useFakeTimers();
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const plugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [plugin],
        dataDir: tmpDataDir,
        callModelOverride: async () =>
          await new Promise(resolve => {
            setTimeout(() => resolve('{"choice": "接受"}'), 5000);
          }),
      });

      await host.start();

      const askPromise = capturedCaps!.ask(CHAT_ENABLED, {
        question: 'Q?',
        choices: ['接受', '拒绝'],
        timeoutMs: 2000,
      });

      vi.advanceTimersByTime(2000);

      await expect(askPromise).rejects.toThrow('timed out after 2000ms');

      await host.stop();
      vi.useRealTimers();
    });

    it('assembles context correctly and returns only { choice, reason }', async () => {
      const config = makeMockConfig({
        test_plugin: {
          enabled: true,
          askModel: 'probe',
        },
      });

      // Provide systemFiles in config
      (config.chats[CHAT_ENABLED] as any).systemFiles = [];
      const identityFile = join(tmpDataDir, 'IDENTITY.md');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(identityFile, 'You are Lucky, a witty Shiba Inu bot.');
      (config.chats[CHAT_ENABLED] as any).systemFiles = [identityFile];

      // Enable memory
      (config.chats[CHAT_ENABLED] as any).memory = {
        enabled: true,
        selfInjectionChars: 500,
      };

      const mockMemoryBackend: any = {
        readSelf: vi.fn(() => ({
          header: '# SELF',
          entries: [
            { date: '2026-10-22', evidence: [], text: '喜欢玩骗子酒馆' },
          ],
        })),
      };

      const mockPipeline: any = {
        getRC: vi.fn(() => [
          {
            receivedAtMs: Date.now() - 5000,
            content: [{ type: 'text', text: '<message id="m1" sender="Alice">来一把？</message>' }],
          },
        ]),
      };

      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;
      let lastModelInput: { modelName: string; prompt: any; options?: any } | undefined;

      const plugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [plugin],
        dataDir: tmpDataDir,
        pipeline: mockPipeline,
        memoryBackend: mockMemoryBackend,
        callModelOverride: async (modelName, prompt, options) => {
          lastModelInput = { modelName, prompt, options };
          return '```json\n{"choice": " 接受 ", "reason": "手痒想玩"}\n```';
        },
      });

      await host.start();

      const result = await capturedCaps!.ask(CHAT_ENABLED, {
        question: '荷官邀请你上桌，要加入吗？',
        choices: ['接受', '拒绝'],
      });

      // 1. Result only contains { choice, reason }, trimmed choice matched
      expect(result).toEqual({
        choice: '接受',
        reason: '手痒想玩',
      });
      // Context is NOT on the result
      expect((result as any).context).toBeUndefined();
      expect((result as any).system).toBeUndefined();

      // 2. Model call options
      expect(lastModelInput!.options?.dumpId).toBe(`${CHAT_ENABLED}.ask`);

      // 3. System prompt contains persona
      const systemText = lastModelInput!.prompt.system;
      expect(systemText).toContain('## Your personality description files');
      expect(systemText).toContain('IDENTITY.md');
      expect(systemText).toContain('You are Lucky, a witty Shiba Inu bot.');
      expect(systemText).toContain('Answer as yourself. Pick exactly one of the choices.');

      // 4. User prompt contains context: time, stats, SELF.md, chatlog tail
      const userText = lastModelInput!.prompt.user;
      expect(userText).toContain('Current time:');
      expect(userText).toContain('Participation stats:');
      expect(userText).toContain('<memory-self>');
      expect(userText).toContain('喜欢玩骗子酒馆');
      expect(userText).toContain('<chatlog>');
      expect(userText).toContain('<message id="m1" sender="Alice">来一把？</message>');
      expect(userText).toContain('荷官邀请你上桌，要加入吗？');
      expect(userText).toContain('- 接受');
      expect(userText).toContain('- 拒绝');

      await host.stop();
    });
  });
});

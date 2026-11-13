import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginHost } from './host';
import { CURRENT_SDK_VERSION, definePlugin, type PluginTool } from '../../plugins/src/sdk';
import { createPluginToolTasks } from '../background-task/plugin-tool';
import type { BackgroundTask } from '../background-task/types';
import type { Config } from '../config/config';
import type { EventSink } from '../event-sink';

const CHAT = 'oc_bg';

const makeConfig = (): Config => ({
  maintainers: [],
  plugins: { slow_plugin: { enabled: true } },
  chats: {
    default: { plugins: {} },
    [CHAT]: { plugins: { slow_plugin: { enabled: true } } },
  },
} as unknown as Config);

const createLogger = () => {
  const logger: any = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withFields: () => logger,
    withError: () => logger,
    withContext: () => logger,
  };
  return logger;
};

const eventSink: EventSink = { persist: vi.fn(), publish: vi.fn(), accept: vi.fn() };

describe('plugin host background tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = async (tool: PluginTool, withTasks = true) => {
    const tasks = createPluginToolTasks();
    const live: BackgroundTask[] = [];
    const startTask = vi.fn((typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => {
      void typeName;
      void sessionId;
      void intention;
      void timeoutMs;
      live.push(tasks.factory.start({ id: live.length + 1, logger: createLogger() }, params as never));
      return live.length;
    });
    const host = createPluginHost({
      config: makeConfig(),
      eventSink,
      logger: createLogger(),
      plugins: [definePlugin({
        id: 'slow_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: { tools: [tool] },
        setup: () => {},
      })],
      ...(withTasks ? { backgroundTask: { tasks, startTask } } : {}),
    });
    await host.start();
    const hostTool = host.getTools(CHAT)[0]!;
    return { host, hostTool, startTask, live };
  };

  const slowTool = (execute: PluginTool['execute'], background = { afterMs: 4000, timeoutMs: 60_000 }): PluginTool => ({
    name: 'slow_lookup',
    description: 'slow',
    parameters: { type: 'object' },
    background,
    execute,
  });

  it('returns the result inline when the tool settles before afterMs', async () => {
    const execute = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { content: 'fast', requiresFollowUp: true };
    });
    const { hostTool, startTask } = await setup(slowTool(execute));

    const pending = hostTool.execute({ q: 1 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual({ content: 'fast', requiresFollowUp: true });
    expect(startTask).not.toHaveBeenCalled();
  });

  it('rethrows an inline failure like an ordinary tool', async () => {
    const { hostTool, startTask } = await setup(slowTool(async () => {
      throw new Error('quick failure');
    }));
    await expect(hostTool.execute({})).rejects.toThrow('quick failure');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('moves a slow call to a background task and returns a task id immediately', async () => {
    let finish!: (content: string) => void;
    const execute = vi.fn(() => new Promise<{ content: string }>(resolve => {
      finish = content => resolve({ content });
    }));
    const { hostTool, startTask, live } = await setup(slowTool(execute));

    const pending = hostTool.execute({ query: 'cats' });
    await vi.advanceTimersByTimeAsync(3999);
    expect(startTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(result.requiresFollowUp).toBe(false);
    const parsed = JSON.parse(result.content as string) as { background_task_id: number; message: string };
    expect(parsed.background_task_id).toBe(1);
    expect(parsed.message).toContain('runtime event');
    expect(startTask).toHaveBeenCalledExactlyOnceWith(
      'plugin_tool',
      CHAT,
      expect.objectContaining({ pluginId: 'slow_plugin', toolName: 'slow_lookup' }),
      'slow_lookup {"query":"cats"}',
      60_000,
    );

    finish('the answer');
    await vi.advanceTimersByTimeAsync(0);
    expect(live[0]!.completed()).toBe(true);
    expect(live[0]!.finalSummary()).toBe('the answer');
  });

  it('reports a late failure as a failed summary', async () => {
    let fail!: (err: Error) => void;
    const { hostTool, live } = await setup(slowTool(() => new Promise((_, reject) => {
      fail = reject;
    })));
    const pending = hostTool.execute({});
    await vi.advanceTimersByTimeAsync(4000);
    await pending;

    fail(new Error('HTTP 500'));
    await vi.advanceTimersByTimeAsync(0);
    expect(live[0]!.finalSummary()).toBe('Tool `slow_lookup` failed: HTTP 500');
  });

  it('abandons the call on timeout and aborts the signal', async () => {
    let signal: AbortSignal | undefined;
    const { hostTool, live } = await setup(slowTool((_input, s) => {
      signal = s;
      return new Promise(() => {});
    }));
    const pending = hostTool.execute({});
    await vi.advanceTimersByTimeAsync(4000);
    await pending;

    live[0]!.kill('timeout');
    expect(live[0]!.finalSummary()).toContain('timed out after 60s');
    expect(signal?.aborted).toBe(true);
  });

  it('runs tools without background exactly as before', async () => {
    const execute = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return { content: 'plain' };
    });
    const tool: PluginTool = { name: 'plain_tool', description: 'plain', parameters: { type: 'object' }, execute };
    const { hostTool, startTask } = await setup(tool);

    const pending = hostTool.execute({ a: 1 });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toEqual({ content: 'plain', requiresFollowUp: false });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ a: 1 });
    expect(startTask).not.toHaveBeenCalled();
  });

  it('awaits inline when the host has no task manager', async () => {
    const { hostTool } = await setup(slowTool(async () => {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      return { content: 'inline' };
    }), false);
    const pending = hostTool.execute({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ content: 'inline', requiresFollowUp: false });
  });
});

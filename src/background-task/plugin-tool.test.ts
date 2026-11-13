import { describe, expect, it, vi } from 'vitest';

import { createPluginToolTasks, PLUGIN_TOOL_SUMMARY_MAX_CHARS, PLUGIN_TOOL_TASK_TYPE, type PluginToolExecution } from './plugin-tool';
import type { BackgroundTask, TaskContext } from './types';

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

const setup = (overrides: Partial<PluginToolExecution> = {}) => {
  const tasks = createPluginToolTasks();
  const started: BackgroundTask[] = [];
  const abort = vi.fn();
  let resolve!: (content: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const startTask = vi.fn((typeName: string, _sessionId: string, params: unknown) => {
    expect(typeName).toBe(PLUGIN_TOOL_TASK_TYPE);
    const ctx: TaskContext = { id: 7, logger: createLogger() };
    started.push(tasks.factory.start(ctx, params as never));
    return 7;
  });
  const id = tasks.spawn(startTask, 'chat-1', {
    pluginId: 'web',
    toolName: 'web_search',
    intention: 'web_search {"query":"q"}',
    timeoutMs: 60_000,
    promise,
    abort,
    ...overrides,
  });
  return { tasks, task: started[0]!, id, abort, resolve, reject, startTask };
};

describe('plugin tool background task', () => {
  it('completes with the tool result as final summary', async () => {
    const { task, resolve } = setup();
    expect(task.completed()).toBe(false);
    resolve('{"results":[1,2,3]}');
    await vi.waitFor(() => expect(task.completed()).toBe(true));
    expect(task.finalSummary()).toBe('{"results":[1,2,3]}');
    expect(task.streamFullOutput()).toBeNull();
  });

  it('truncates long results and keeps the full text streamable', async () => {
    const { task, resolve } = setup();
    const long = 'x'.repeat(PLUGIN_TOOL_SUMMARY_MAX_CHARS + 500);
    resolve(long);
    await vi.waitFor(() => expect(task.completed()).toBe(true));
    const summary = task.finalSummary()!;
    expect(summary).toContain('[... 500 characters truncated ...]');
    expect(summary.length).toBeLessThan(long.length);
    const chunks: string[] = [];
    for await (const chunk of task.streamFullOutput()!) chunks.push(String(chunk));
    expect(chunks.join('')).toBe(long);
  });

  it('turns a rejection into a failed summary instead of throwing', async () => {
    const { task, reject } = setup();
    reject(new Error('HTTP 502: upstream'));
    await vi.waitFor(() => expect(task.completed()).toBe(true));
    expect(task.finalSummary()).toBe('Tool `web_search` failed: HTTP 502: upstream');
  });

  it('kill(timeout) completes with a timeout summary, aborts and ignores the late result', async () => {
    const { task, abort, resolve } = setup();
    task.kill('timeout');
    expect(task.completed()).toBe(true);
    expect(task.finalSummary()).toBe('Tool `web_search` timed out after 60s and was abandoned.');
    expect(abort).toHaveBeenCalledWith('timed out');
    resolve('late');
    await Promise.resolve();
    expect(task.finalSummary()).toContain('timed out');
  });

  it('kill(tool_call) reports cancellation', () => {
    const { task } = setup();
    task.kill('tool_call');
    expect(task.finalSummary()).toBe('Tool `web_search` was cancelled.');
  });

  it('pause aborts the call and records no checkpoint', () => {
    const { task, abort } = setup();
    expect(task.pause()).toBeNull();
    expect(abort).toHaveBeenCalledWith('runtime shutting down');
    expect(task.completed()).toBe(false);
  });

  it('recover completes immediately as interrupted by restart', () => {
    const { tasks } = setup();
    const recovered = tasks.factory.recover(
      { id: 9, logger: createLogger() },
      { pluginId: 'web', toolName: 'web_fetch', handle: '1' },
      null,
    );
    expect(recovered.completed()).toBe(true);
    expect(recovered.finalSummary()).toBe('Tool `web_fetch` interrupted: runtime restarted.');
  });

  it('start fails for a handle nobody parked', () => {
    const { tasks } = setup();
    expect(() => tasks.factory.start(
      { id: 1, logger: createLogger() },
      { pluginId: 'web', toolName: 'web_fetch', handle: 'missing' },
    )).toThrow(/no pending execution/);
  });

  it('does not leak the parked execution when startTask throws', async () => {
    const tasks = createPluginToolTasks();
    const rejecting = Promise.reject(new Error('boom'));
    expect(() => tasks.spawn(() => {
      throw new Error('no manager');
    }, 'chat-1', {
      pluginId: 'web',
      toolName: 'web_search',
      intention: undefined,
      timeoutMs: 1000,
      promise: rejecting,
      abort: () => {},
    })).toThrow('no manager');
    await Promise.resolve();
  });
});

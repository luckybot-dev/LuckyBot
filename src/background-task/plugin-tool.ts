import { Readable } from 'node:stream';

import { signal } from 'alien-signals';

import type { BackgroundTask, BackgroundTaskFactory, TaskContext } from './types';

export const PLUGIN_TOOL_TASK_TYPE = 'plugin_tool';

// The completion event is the only channel a non-maintainer gets (read_task_output
// is gated with bash), so the summary carries the result itself. The complete
// text stays reachable through streamFullOutput when it had to be cut.
export const PLUGIN_TOOL_SUMMARY_MAX_CHARS = 4000;

export interface PluginToolTaskParams {
  pluginId: string;
  toolName: string;
  handle: string;
}

export interface PluginToolExecution {
  pluginId: string;
  toolName: string;
  intention: string | undefined;
  timeoutMs: number;
  // Settles with the tool's result content; a rejection becomes a failed summary.
  promise: Promise<string>;
  // Cooperative cancel for the plugin (timeout, kill_task, shutdown).
  abort: (reason: string) => void;
}

type StartTask = (
  typeName: string,
  sessionId: string,
  params: unknown,
  intention: string | undefined,
  timeoutMs: number,
) => number;

const truncateSummary = (content: string): { summary: string; truncated: boolean } => {
  if (content.length <= PLUGIN_TOOL_SUMMARY_MAX_CHARS)
    return { summary: content, truncated: false };
  let cut = PLUGIN_TOOL_SUMMARY_MAX_CHARS;
  // Do not split a surrogate pair.
  if ((content.charCodeAt(cut - 1) & 0xFC00) === 0xD800) cut--;
  const omitted = content.length - cut;
  return {
    summary: `${content.slice(0, cut)}\n\n[... ${omitted} characters truncated ...]`,
    truncated: true,
  };
};

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

/**
 * Background task type for plugin tools that outlived their `background.afterMs`.
 *
 * The still-running promise cannot be persisted, so `spawn` parks it under a
 * handle that only the in-process `start` can claim; the DB row keeps just the
 * serializable params. After a restart `recover` can only report the loss.
 */
export const createPluginToolTasks = () => {
  const pending = new Map<string, PluginToolExecution>();
  let nextHandle = 1;

  const factory: BackgroundTaskFactory<PluginToolTaskParams, null> = {
    typeName: PLUGIN_TOOL_TASK_TYPE,

    start(ctx: TaskContext, params: PluginToolTaskParams): BackgroundTask {
      const execution = pending.get(params.handle);
      if (!execution) throw new Error(`Plugin tool task ${ctx.id}: no pending execution for handle ${params.handle}`);
      pending.delete(params.handle);

      const startedMs = Date.now();
      const _completed = signal(false);
      const _finalSummary = signal<string | undefined>(undefined);
      let fullContent: string | undefined;

      // First settlement wins: a kill or timeout abandons the promise, and its
      // late result must not overwrite the summary the model already saw.
      const finish = (summary: string, full?: string) => {
        if (_completed()) return;
        fullContent = full;
        _finalSummary(summary);
        _completed(true);
      };

      execution.promise.then(
        content => {
          const { summary, truncated } = truncateSummary(content);
          finish(summary, truncated ? content : undefined);
        },
        (err: unknown) => {
          ctx.logger.withError(err).warn('Plugin tool failed in background');
          finish(`Tool \`${params.toolName}\` failed: ${errorMessage(err)}`);
        },
      );

      return {
        completed: _completed,
        finalSummary: _finalSummary,

        renderLiveSummary() {
          const runningSec = Math.round((Date.now() - startedMs) / 1000);
          return `Plugin tool \`${params.toolName}\` (${params.pluginId}), running for ${runningSec}s`;
        },

        streamFullOutput() {
          return fullContent === undefined ? null : Readable.from([fullContent]);
        },

        pause() {
          execution.abort('runtime shutting down');
          return null;
        },

        kill(reason) {
          execution.abort(reason === 'timeout' ? 'timed out' : 'cancelled');
          finish(reason === 'timeout'
            ? `Tool \`${params.toolName}\` timed out after ${Math.round(execution.timeoutMs / 1000)}s and was abandoned.`
            : `Tool \`${params.toolName}\` was cancelled.`);
        },

        dispose() {},
      };
    },

    recover(_ctx: TaskContext, params: PluginToolTaskParams, _checkpoint: null): BackgroundTask {
      const summary = `Tool \`${params.toolName}\` interrupted: runtime restarted.`;
      return {
        completed: () => true,
        finalSummary: () => summary,
        renderLiveSummary: () => '',
        streamFullOutput: () => null,
        pause: () => null,
        kill() {},
        dispose() {},
      };
    },
  };

  /** Hand a running tool call to the task manager; returns the task id. */
  const spawn = (startTask: StartTask, sessionId: string, execution: PluginToolExecution): number => {
    const handle = String(nextHandle++);
    pending.set(handle, execution);
    try {
      return startTask(
        PLUGIN_TOOL_TASK_TYPE,
        sessionId,
        { pluginId: execution.pluginId, toolName: execution.toolName, handle } satisfies PluginToolTaskParams,
        execution.intention,
        execution.timeoutMs,
      );
    } catch (err) {
      pending.delete(handle);
      // Nothing will ever consume the promise; keep its rejection from surfacing.
      execution.promise.catch(() => {});
      throw err;
    }
  };

  return { factory, spawn };
};

export type PluginToolTasks = ReturnType<typeof createPluginToolTasks>;

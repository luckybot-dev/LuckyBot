import { plugins } from '../../../plugins/src/index';
import { createPluginHost } from '../../plugins/host';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerPlugins = ({ get, register }: Registrar): void => {
  register(TOKENS.PLUGIN_HOST, () =>
    createPluginHost({
      config: get(TOKENS.CONFIG),
      eventSink: get(TOKENS.EVENT_SINK),
      logger: get(TOKENS.LOGGER),
      plugins,
      pipeline: get(TOKENS.PIPELINE),
      memoryBackend: get(TOKENS.MEMORY_BACKEND),
      // Lazy: the manager is built from Driver-side services, so resolve it at
      // first use rather than while constructing the host.
      backgroundTask: {
        tasks: get(TOKENS.PLUGIN_TOOL_TASKS),
        startTask: (typeName, sessionId, params, intention, timeoutMs) =>
          get(TOKENS.BACKGROUND_TASK_MANAGER).startTask(typeName, sessionId, params, intention, timeoutMs),
      },
    }));
};

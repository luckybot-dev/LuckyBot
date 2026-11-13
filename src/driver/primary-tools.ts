import { execFile } from 'node:child_process';

import type { Logger } from '@guiiai/logg';

import type { DriverPlatform } from './platform';
import {
  createAttachmentDownloader,
  createBanSpammerTool,
  createBashTool,
  createDownloadFileTool,
  createEndTurnTool,
  createKillTaskTool,
  createReactTool,
  createReadImageTool,
  createReadOldMessagesTool,
  createReadTaskOutputTool,
  createSendMessageTool,
} from './tools';
import type { CahciuaTool } from './tools';
import type { ResolvedChatConfig, RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import { renderImageToTextSystemPrompt } from '../media/image-to-text-prompt';
import { callDescriptionLlm } from '../media/llm-description';

type ImageDetail = 'low' | 'high';

export interface PrimaryToolsConfig {
  imageToText: Pick<ResolvedChatConfig['imageToText'], 'enabled' | 'model'>;
  tools: ResolvedChatConfig['tools'];
}

export interface PrimaryToolsDependencies extends Pick<
  DriverPlatform,
  'sendMessage' | 'banSpammer' | 'setMessageReaction' | 'loadMessageAttachments' | 'messageExists' | 'downloadMessageMedia' | 'supportsOutboundAttachments'
> {
  chatId: string;
  chatConfig: PrimaryToolsConfig;
  runtimeConfig: RuntimeConfig;
  readOldMessages: (chatId: string, messageIds: string[]) => Promise<string> | string;
  // Resolve a rendered alias (or a canonical id) to the canonical id used by
  // the platform and by `messageExists`. Unknown input passes through so the
  // existing unknown-id errors still apply.
  resolveMessageId?: (raw: string) => string;
  // Render a canonical message id the way the chatlog shows it, so a tool
  // result that echoes a sent id stays consistent with the context.
  formatMessageId?: (messageId: string) => string;
  resolveModel: (name: string) => LlmEndpoint;
  backgroundTask: {
    startTask: (
      typeName: string,
      sessionId: string,
      params: unknown,
      intention: string | undefined,
      timeoutMs: number,
    ) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    readTaskOutput: (
      taskId: number,
      offset?: number,
      limit?: number,
    ) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  pluginTools?: CahciuaTool[];
  log: Logger;
}

const createFileReader = (runtime: RuntimeConfig) => async (path: string): Promise<Buffer> => {
  const readFileCommand = runtime.readFile;
  return await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      readFileCommand[0]!,
      [...readFileCommand.slice(1), path],
      { timeout: 60_000, maxBuffer: runtime.readFileSizeLimit, encoding: null },
      (error, stdout) => {
        if (error) reject(new Error(`Failed to read file: ${error.message}`));
        else resolve(stdout);
      },
    );
    if (!child.stdin) throw new Error('Runtime read command has no stdin stream');
    child.stdin.end();
  });
};

const createImageToTextResolver = (
  deps: PrimaryToolsDependencies,
): ((buffer: Buffer, detail: ImageDetail) => Promise<string>) | undefined => {
  if (!deps.chatConfig.imageToText.enabled) return undefined;
  const modelName = deps.chatConfig.imageToText.model;
  if (!modelName) throw new Error('imageToText.model is required when imageToText.enabled=true');

  return async (buffer, detail) => {
    const system = await renderImageToTextSystemPrompt({ caption: '', detail });
    const result = await callDescriptionLlm({
      model: deps.resolveModel(modelName),
      system,
      userText: 'Describe this image.',
      images: [buffer],
      log: deps.log,
      label: 'read-image',
    });
    return result.text.trim();
  };
};

const createUnsupportedAttachmentDownloader = () => async (): Promise<Buffer> => {
  throw new Error('Chat attachments are not available on this platform. Use `path` for local files.');
};

export const createPrimaryTools = (deps: PrimaryToolsDependencies): CahciuaTool[] => {
  const { loadMessageAttachments, downloadMessageMedia, banSpammer } = deps;
  if ((loadMessageAttachments == null) !== (downloadMessageMedia == null))
    throw new Error('Platform attachment capability requires both loadMessageAttachments and downloadMessageMedia');
  const inboundAttachmentsSupported = loadMessageAttachments != null && downloadMessageMedia != null;

  // send_message resolves its reply_to twice (existence check, then send) and
  // react checks before setting; memoize per tool set so a wake-up resolves each
  // id at most once, including unresolved aliases (cached as their raw value).
  const resolvedMessageIds = new Map<string, string>();
  const resolveMessageId = (raw: string): string => {
    const cached = resolvedMessageIds.get(raw);
    if (cached !== undefined) return cached;
    const resolved = deps.resolveMessageId?.(raw) ?? raw;
    resolvedMessageIds.set(raw, resolved);
    return resolved;
  };
  const formatMessageId = (messageId: string): string => deps.formatMessageId?.(messageId) ?? messageId;
  const messageExists = (messageId: string) => deps.messageExists(deps.chatId, resolveMessageId(messageId));
  const sendMessageTool = createSendMessageTool(async (text, replyTo, attachments) => {
    const resolvedReplyTo = replyTo == null ? undefined : resolveMessageId(replyTo);
    deps.log.withFields({
      chatId: deps.chatId,
      text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
      replyTo: resolvedReplyTo,
      attachments: attachments?.length ?? 0,
    }).log('send_message tool called');
    const sent = await deps.sendMessage(
      deps.chatId,
      text,
      resolvedReplyTo,
      attachments,
    );
    return { messageId: formatMessageId(sent.messageId) };
  }, messageExists, { attachments: deps.supportsOutboundAttachments === true });

  const downloadAttachment = inboundAttachmentsSupported
    ? createAttachmentDownloader({
        chatId: deps.chatId,
        resolveMessageId,
        loadMessageAttachments,
        downloadMessageMedia,
      })
    : createUnsupportedAttachmentDownloader();

  const tools: CahciuaTool[] = [
    sendMessageTool,
    ...(deps.chatConfig.tools.banSpammer && banSpammer
      ? [createBanSpammerTool(messageId => banSpammer(deps.chatId, messageId))]
      : []),
    createReactTool(
      (messageId, emoji) => deps.setMessageReaction(deps.chatId, resolveMessageId(messageId), emoji),
      messageExists,
    ),
  ];

  if (deps.chatConfig.tools.bash.enabled) {
    tools.push(createBashTool(deps.runtimeConfig, {
      startTask: deps.backgroundTask.startTask,
      sessionId: deps.chatId,
      backgroundThresholdSec: deps.chatConfig.tools.bash.backgroundThresholdSec,
    }));
  }

  if (deps.pluginTools) {
    tools.push(...deps.pluginTools);
  }

  if (inboundAttachmentsSupported) {
    tools.push(createDownloadFileTool({
      downloadAttachment,
      runtime: deps.runtimeConfig,
    }));
  }
  tools.push(
    createReadImageTool({
      downloadAttachment,
      readFile: createFileReader(deps.runtimeConfig),
      resolveImageToText: createImageToTextResolver(deps),
    }),
    createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)),
    createReadTaskOutputTool((taskId, offset, limit) =>
      deps.backgroundTask.readTaskOutput(taskId, offset, limit)),
    createReadOldMessagesTool(messageIds => deps.readOldMessages(deps.chatId, messageIds.map(resolveMessageId))),
    createEndTurnTool(),
  );

  return tools;
};

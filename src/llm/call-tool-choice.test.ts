import type { Logger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callLlm, type LlmCallConfig } from './call';
import { chatCompletions } from './chat';
import { resetToolChoiceLatches, TOOL_CHOICE_REJECTION_TTL_MS } from './tool-choice';
import type { ConversationEntry } from '../unified-api/types';

vi.mock('./request-dump', () => ({ dumpLlmPayload: vi.fn() }));
vi.mock('./chat', () => ({ chatCompletions: vi.fn() }));

const mockChat = vi.mocked(chatCompletions);
const warn = vi.fn();
const log = { withError: () => log, withFields: () => log, warn, debug: vi.fn(), log: vi.fn() } as unknown as Logger;

const config: LlmCallConfig = {
  apiBaseUrl: 'http://gateway/v1',
  apiKey: 'key',
  model: 'thinking-model',
  apiFormat: 'openai-chat',
  forceToolChoice: 'any',
};
const entries: ConversationEntry[] = [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }];
const tools = [{ name: 'end_turn', description: 'End the turn.', parameters: { type: 'object', properties: {} } }];
const ok = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
} as unknown as Awaited<ReturnType<typeof chatCompletions>>;
const rejection = () => new Error(
  'Chat Completions API 400: {"error":{"message":"Thinking mode does not support this tool_choice"}}',
);
const sentChoices = () => mockChat.mock.calls.map(call => call[0].forceToolChoice);
const call = () => callLlm(config, entries, 'system', tools, { log, label: 'test' });

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  resetToolChoiceLatches();
  mockChat.mockReset();
  warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('callLlm forced tool_choice fallback', () => {
  it('sends the forced choice and keeps sending it while the provider accepts it', async () => {
    mockChat.mockResolvedValue(ok);
    await call();
    await call();
    expect(sentChoices()).toEqual(['any', 'any']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('calls again without the choice when the provider rejects it', async () => {
    mockChat.mockRejectedValueOnce(rejection()).mockResolvedValue(ok);
    await expect(call()).resolves.toMatchObject({ usage: ok.usage });
    expect(sentChoices()).toEqual(['any', undefined]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips the choice for the endpoint until the latch expires, then tries it again', async () => {
    mockChat.mockRejectedValueOnce(rejection()).mockResolvedValue(ok);
    await call();
    await call();
    expect(sentChoices()).toEqual(['any', undefined, undefined]);

    vi.setSystemTime(1_000_000 + TOOL_CHOICE_REJECTION_TTL_MS);
    await call();
    expect(sentChoices()).toEqual(['any', undefined, undefined, 'any']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('latches per endpoint', async () => {
    mockChat.mockRejectedValueOnce(rejection()).mockResolvedValue(ok);
    await call();
    await callLlm({ ...config, model: 'other-model' }, entries, 'system', tools, { log, label: 'test' });
    expect(sentChoices()).toEqual(['any', undefined, 'any']);
  });

  it('propagates other failures without retrying', async () => {
    mockChat.mockRejectedValue(new Error('Chat Completions API 400: context length exceeded'));
    await expect(call()).rejects.toThrow('context length exceeded');
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('propagates a failure of the unforced call', async () => {
    mockChat.mockRejectedValueOnce(rejection()).mockRejectedValueOnce(new Error('Chat Completions API 503: overloaded'));
    await expect(call()).rejects.toThrow('503');
    expect(sentChoices()).toEqual(['any', undefined]);
  });

  it('never sends a choice the caller did not ask for', async () => {
    mockChat.mockResolvedValue(ok);
    await callLlm({ ...config, forceToolChoice: undefined }, entries, 'system', tools, { log, label: 'test' });
    expect(sentChoices()).toEqual([undefined]);
  });
});

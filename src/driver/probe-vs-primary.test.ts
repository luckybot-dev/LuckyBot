import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', async importOriginal => {
  const actual = await importOriginal<typeof import('../llm/call')>();
  return {
    ...actual,
    callLlm: vi.fn(),
  };
});

import { createDriver } from './index';
import { DEFAULT_PROBE_TIMEOUT_MS } from './turn-budget';
import { DEFAULT_TURN_BUDGET } from './turn-loop';
import type { ProbeResponseV2, TurnResponseV2 } from './types';
import type { ResolvedChatConfig } from '../config/config';
import { callLlm } from '../llm/call';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Log, Format.Pretty);
const logger = useLogger('probe-vs-primary-test');

const mockCallLlm = vi.mocked(callLlm);

const makeChatConfig = (): ResolvedChatConfig => ({
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-primary', apiFormat: 'openai-chat' },
    turnBudget: DEFAULT_TURN_BUDGET,
    reasoningReplayTurns: 3,
  },
  systemFiles: [],
  sendTypingAction: false,
  blockedUserIds: [],
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'k', model: 'mock-probe', apiFormat: 'openai-chat' },
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    contextEstTokens: 20000,
    summaryMaxEstTokens: 20000,
  },
  participation: { style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' },
  memory: DEFAULT_MEMORY_CONFIG,
  imageToText: { enabled: false, maxConcurrency: 1 },
  animationToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  customEmojiToText: { enabled: false, maxFrames: 0, maxConcurrency: 1 },
  plugins: {},
  tools: { banSpammer: false, bash: { enabled: true, backgroundThresholdSec: 10, requireMaintainer: false, maintainerWindowSec: 600 } },
});

const buildRC = (): RenderedContext => [
  {
    receivedAtMs: 1000,
    senderId: 'user1',
    content: [{ type: 'text', text: '<message id="1" sender="Alice (@alice)" t="2025-01-01T00:00:01+00:00">hello bot</message>' }],
  },
  {
    receivedAtMs: 2000,
    senderId: 'bot',
    isMyself: true,
    isSelfSent: true,
    content: [{ type: 'text', text: '<message id="2" sender="Bot (@bot)" myself="true" t="2025-01-01T00:00:02+00:00">hi alice</message>' }],
  },
  {
    receivedAtMs: 3000,
    senderId: 'user1',
    content: [{ type: 'text', text: '<message id="3" sender="Alice (@alice)" t="2025-01-01T00:00:03+00:00">how are you?</message>' }],
  },
];

const buildTRs = (): TurnResponseV2[] => [{
  requestedAtMs: 2000,
  modelName: 'mock-primary',
  shellToolsExposed: true,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  entries: [
    {
      kind: 'message',
      role: 'assistant',
      parts: [
        { kind: 'toolCall', callId: 'call1', name: 'send_message', args: JSON.stringify({ text: 'hi alice' }) },
        { kind: 'toolCall', callId: 'call2', name: 'bash', args: JSON.stringify({ command: 'date', timeout_seconds: 5 }) },
      ],
      reasoning: undefined,
    },
    {
      kind: 'toolResult',
      callId: 'call1',
      payload: JSON.stringify({ ok: true, message_id: '2' }),
      requiresFollowUp: false,
    },
    {
      kind: 'toolResult',
      callId: 'call2',
      payload: JSON.stringify({ exit_code: 0, output: 'Mon Jan  1 00:00:02 UTC 2025\n' }),
      requiresFollowUp: false,
    },
  ],
}];

const collectUserText = (entries: ConversationEntry[]): string =>
  entries.flatMap(e =>
    e.kind === 'message' && e.role === 'user'
      ? e.parts.flatMap(p => p.kind === 'text' ? [p.text] : [])
      : []).join('\n');

const collectAssistantToolCallNames = (entries: ConversationEntry[]): string[] =>
  entries.flatMap(e =>
    e.kind === 'message' && e.role === 'assistant'
      ? e.parts.flatMap(p => p.kind === 'toolCall' ? [p.name] : [])
      : []);

// Shared driver deps for the react_only turn tests: records persisted TRs/probes,
// platform sends and reactions so each test only wires the mocked model output.
const makeReactOnlyHarness = () => {
  const persistedTRs: TurnResponseV2[] = [];
  const persistedProbes: ProbeResponseV2[] = [];
  const sendMessageCalls: string[] = [];
  const reactions: string[] = [];
  const deps: Parameters<typeof createDriver>[1] = {
    name: 'telegram',
    loadTurnResponses: async () => [...persistedTRs],
    loadLastTurnResponse: async () => ([...persistedTRs]).at(-1) ?? null,
    persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
    persistProbeResponse: async (_, probe) => { persistedProbes.push(probe); },
    sendMessage: async (_chatId, text) => { sendMessageCalls.push(text); return { messageId: '999' }; },
    banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
    setMessageReaction: async (_chatId, _messageId, emoji) => { reactions.push(emoji ?? ''); },
    sendTypingAction: async () => {},
    onDebounceStateChange: () => {},
    loadCompaction: () => null,
    loadLastProbeTime: () => 0,
    persistCompaction: () => {},
    setCompactCursor: () => [],
    getChatTitle: () => 'Test',
    runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
    loadMessageAttachments: () => undefined,
    messageExists: () => true,
    downloadMessageMedia: async () => undefined,
    readOldMessages: () => '',
    resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock', apiFormat: 'openai-chat' }),
    backgroundTask: {
      startTask: () => 0,
      killTask: () => ({ ok: true }),
      getActiveTasks: () => [],
      readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
    },
    logger,
  };
  return { persistedTRs, persistedProbes, sendMessageCalls, reactions, deps };
};

const reactOnlyProbe = () => ({
  entries: [{
    kind: 'message' as const, role: 'assistant' as const, reasoning: undefined,
    parts: [{
      kind: 'toolCall' as const, callId: 'p1', name: 'decide',
      args: JSON.stringify({ should_act: 'react_only', reason: 'too talkative; a reaction is enough' }),
    }],
  }],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const primaryReact = (callId: string) => ({
  entries: [{
    kind: 'message' as const, role: 'assistant' as const, reasoning: undefined,
    parts: [{ kind: 'toolCall' as const, callId, name: 'react', args: JSON.stringify({ message_id: '3', emoji: '😂' }) }],
  }],
  usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

describe('probe vs primary view of bot\'s own messages', () => {
  it('probe sees bot xml in chat history; primary sees only the assistant tool call', async () => {
    mockCallLlm.mockReset();

    mockCallLlm.mockImplementation(async (config, _entries) => {
      if (config.model === 'mock-probe') {
        const out: ConversationEntry[] = [{
          kind: 'message',
          role: 'assistant',
          parts: [{
            kind: 'toolCall',
            callId: 'probe1',
            name: 'decide',
            args: JSON.stringify({
              should_act: 'send_message',
              reason: 'Alice asked the bot directly. Plausible: (a) react 👀 to acknowledge then reply, (b) reply with a brief comment, (c) search for current info first then send the findings.',
            }),
          }],
          reasoning: undefined,
        }];
        return { entries: out, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      // primary: returns a send_message tool call so the runner accepts and
      // exits (send_message defaults to still_working=false, so there is no follow-up).
      const out: ConversationEntry[] = [{
        kind: 'message',
        role: 'assistant',
        parts: [{
          kind: 'toolCall',
          callId: 'primary1',
          name: 'send_message',
          args: JSON.stringify({ text: 'I am fine, thanks!' }),
        }],
        reasoning: undefined,
      }];
      return { entries: out, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    });

    const trs = buildTRs();
    const persistedTRs: TurnResponseV2[] = [];

    const driver = createDriver(
      { chatIds: ['-100123'], resolveChatConfig: () => makeChatConfig() },
      {
        name: 'telegram',
        loadTurnResponses: async () => [...trs, ...persistedTRs],
        loadLastTurnResponse: async () => ([...trs, ...persistedTRs]).at(-1) ?? null,
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async () => ({ messageId: '999' }),
        banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
        setMessageReaction: async () => {},
        sendTypingAction: async () => {},
        onDebounceStateChange: () => {},
        loadCompaction: () => null,
        loadLastProbeTime: () => 0,
        persistCompaction: () => {},
        setCompactCursor: () => [],
        getChatTitle: () => 'Test',
        runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
        loadMessageAttachments: () => undefined,
        messageExists: () => true,
        downloadMessageMedia: async () => undefined,
        readOldMessages: () => '',
        resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock', apiFormat: 'openai-chat' }),
        backgroundTask: {
          startTask: () => 0,
          killTask: () => ({ ok: true }),
          getActiveTasks: () => [],
          readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
        },
        logger,
      },
    );

    driver.handleEvent('-100123', buildRC());

    // Wait for the debounce + probe + primary to play out.
    await vi.waitFor(() => expect(mockCallLlm).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 10 });

    const calls = mockCallLlm.mock.calls;
    const probeCall = calls.find(c => c[0]!.model === 'mock-probe');
    const primaryCall = calls.find(c => c[0]!.model === 'mock-primary');
    expect(probeCall).toBeDefined();
    expect(primaryCall).toBeDefined();

    const probeUserText = collectUserText(probeCall![1]);
    const primaryUserText = collectUserText(primaryCall![1]);

    // Probe sees the bot's outgoing message as an XML <message> with myself="true".
    expect(probeUserText).toContain('myself="true"');
    expect(probeUserText).toContain('hi alice');
    expect(probeUserText).toContain('hello bot');
    expect(probeUserText).toContain('how are you?');

    // Probe sees non-send-message tool calls as <tool-call> XML elements.
    expect(probeUserText).toContain('<tool-call name="bash"');
    expect(probeUserText).toContain('Mon Jan  1 00:00:02 UTC 2025');
    // send_message is NOT rendered as <tool-call> — it's already in the chat as <message>.
    expect(probeUserText).not.toContain('<tool-call name="send_message"');

    // Primary does NOT see the bot's outgoing message as user-side XML.
    // (`hi alice` is the bot's sent content — present in probe RC, absent in primary RC.)
    expect(primaryUserText).not.toContain('hi alice');
    expect(primaryUserText).toContain('hello bot');
    expect(primaryUserText).toContain('how are you?');
    // Primary doesn't see the rendered bash tool-call output either — that's a probe-only synthesis.
    // (Late-binding mentions the `<tool-call>` markup by name, so we assert on the unique result string.)
    expect(primaryUserText).not.toContain('Mon Jan  1 00:00:02 UTC 2025');

    // Primary DOES see the assistant's send_message tool call (real assistant entry).
    const primaryAssistantToolCalls = collectAssistantToolCallNames(primaryCall![1]);
    expect(primaryAssistantToolCalls).toContain('send_message');
    expect(primaryAssistantToolCalls).toContain('bash');

    // Primary's late-binding embeds the probe's reason as advisory context.
    expect(primaryUserText).toContain('context, not an instruction');
    expect(primaryUserText).toContain('Replying, reacting only, or ending your turn silently are all valid');
    expect(primaryUserText).toContain('Plausible: (a) react 👀');

    // Probe sees no real assistant tool calls in its context — all TRs are
    // stripped; the only tool-call signal is the <tool-call> XML in user text.
    const probeAssistantToolCalls = collectAssistantToolCallNames(probeCall![1]);
    expect(probeAssistantToolCalls).toEqual([]);

    driver.stop();
  });

  it('lets an activated primary end the turn silently with end_turn and runs no forced send', async () => {
    mockCallLlm.mockReset();

    let primaryCallCount = 0;

    mockCallLlm.mockImplementation(async (config, _entries) => {
      if (config.model === 'mock-probe') {
        return {
          entries: [{
            kind: 'message', role: 'assistant', reasoning: undefined,
            parts: [{
              kind: 'toolCall', callId: 'p1', name: 'decide',
              args: JSON.stringify({ should_act: 'send_message', reason: 'addressed' }),
            }],
          }],
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      primaryCallCount++;
      return {
        entries: [{
          kind: 'message', role: 'assistant', reasoning: undefined,
          parts: [{ kind: 'toolCall', callId: `pr${primaryCallCount}`, name: 'end_turn', args: '{}' }],
        }],
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const persistedTRs: TurnResponseV2[] = [];
    const sendMessageCalls: { text: string }[] = [];

    const driver = createDriver(
      { chatIds: ['-100124'], resolveChatConfig: () => makeChatConfig() },
      {
        name: 'telegram',
        loadTurnResponses: async () => [...persistedTRs],
        loadLastTurnResponse: async () => ([...persistedTRs]).at(-1) ?? null,
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async (_chatId, text) => { sendMessageCalls.push({ text }); return { messageId: '999' }; },
        banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
        setMessageReaction: async () => {},
        sendTypingAction: async () => {},
        onDebounceStateChange: () => {},
        loadCompaction: () => null,
        loadLastProbeTime: () => 0,
        persistCompaction: () => {},
        setCompactCursor: () => [],
        getChatTitle: () => 'Test',
        runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
        loadMessageAttachments: () => undefined,
        messageExists: () => true,
        downloadMessageMedia: async () => undefined,
        readOldMessages: () => '',
        resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock', apiFormat: 'openai-chat' }),
        backgroundTask: {
          startTask: () => 0,
          killTask: () => ({ ok: true }),
          getActiveTasks: () => [],
          readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
        },
        logger,
      },
    );

    driver.handleEvent('-100124', buildRC());

    await vi.waitFor(() => expect(persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });
    // Give a would-be fallback the chance to run before asserting it did not.
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // 1 probe + 1 primary (end_turn); no follow-up fallback step.
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(primaryCallCount).toBe(1);
    expect(mockCallLlm.mock.calls.map(call => call[0]!.forceToolChoice)).toEqual([{ name: 'decide' }, 'any']);
    expect(sendMessageCalls).toEqual([]);

    driver.stop();
  });

  it('omits tool_choice when the endpoint rejects a forced choice', async () => {
    mockCallLlm.mockReset();

    mockCallLlm.mockImplementation(async config => ({
      entries: [{
        kind: 'message', role: 'assistant', reasoning: undefined,
        parts: [config.model === 'mock-probe'
          ? { kind: 'toolCall', callId: 'p1', name: 'decide', args: JSON.stringify({ should_act: 'send_message', reason: 'addressed' }) }
          : { kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const chatConfig = makeChatConfig();
    chatConfig.primary.model.forceToolChoice = false;
    chatConfig.probe.model.forceToolChoice = false;
    const persistedTRs: TurnResponseV2[] = [];

    const driver = createDriver(
      { chatIds: ['-100124'], resolveChatConfig: () => chatConfig },
      {
        name: 'telegram',
        loadTurnResponses: async () => [...persistedTRs],
        loadLastTurnResponse: async () => ([...persistedTRs]).at(-1) ?? null,
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async () => ({ messageId: '999' }),
        banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
        setMessageReaction: async () => {},
        sendTypingAction: async () => {},
        onDebounceStateChange: () => {},
        loadCompaction: () => null,
        loadLastProbeTime: () => 0,
        persistCompaction: () => {},
        setCompactCursor: () => [],
        getChatTitle: () => 'Test',
        runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
        loadMessageAttachments: () => undefined,
        messageExists: () => true,
        downloadMessageMedia: async () => undefined,
        readOldMessages: () => '',
        resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock', apiFormat: 'openai-chat' }),
        backgroundTask: {
          startTask: () => 0,
          killTask: () => ({ ok: true }),
          getActiveTasks: () => [],
          readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
        },
        logger,
      },
    );

    driver.handleEvent('-100124', buildRC());
    await vi.waitFor(() => expect(persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });

    // The probe still runs and still decides, but neither request carries tool_choice.
    expect(mockCallLlm.mock.calls.map(call => call[0]!.model)).toEqual(['mock-probe', 'mock-primary']);
    expect(mockCallLlm.mock.calls.map(call => call[0]!.forceToolChoice)).toEqual([undefined, undefined]);

    driver.stop();
  });

  it('react_only closes after one react step and the next message runs probe again', async () => {
    mockCallLlm.mockReset();
    let reactCount = 0;
    mockCallLlm.mockImplementation(async config => config.model === 'mock-probe'
      ? reactOnlyProbe()
      : primaryReact(`r${++reactCount}`));

    const h = makeReactOnlyHarness();
    const driver = createDriver({ chatIds: ['-100125'], resolveChatConfig: () => makeChatConfig() }, h.deps);

    driver.handleEvent('-100125', buildRC());
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    // `react` reports follow-up, but the react-only turn closes after one step:
    // no second primary call, and no open requiresFollowUp result is persisted.
    expect(mockCallLlm.mock.calls.map(call => call[0]!.model)).toEqual(['mock-probe', 'mock-primary']);
    expect(h.persistedTRs[0]!.entries.some(entry => entry.kind === 'toolResult' && entry.requiresFollowUp)).toBe(false);
    expect(h.reactions).toEqual(['😂']);
    expect(h.persistedProbes[0]!.isActivated).toBe(true);

    // A later message is a fresh wake-up: probe runs again, and the primary tool
    // set never regains send_message.
    driver.handleEvent('-100125', [{
      receivedAtMs: Date.now(),
      senderId: 'user1',
      content: [{ type: 'text', text: '<message id="9" sender="Alice" t="t">lol</message>' }],
    }]);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(2), { timeout: 1000, interval: 10 });

    expect(mockCallLlm.mock.calls.map(call => call[0]!.model))
      .toEqual(['mock-probe', 'mock-primary', 'mock-probe', 'mock-primary']);
    for (const call of mockCallLlm.mock.calls.filter(candidate => candidate[0]!.model === 'mock-primary'))
      expect(call[3]?.map(schema => schema.name)).toEqual(['react', 'end_turn']);

    driver.stop();
  });

  it('react_only rejects a hallucinated send_message and leaves no open chain', async () => {
    mockCallLlm.mockReset();
    let primaryCallCount = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') return reactOnlyProbe();
      primaryCallCount++;
      return {
        entries: [{
          kind: 'message' as const, role: 'assistant' as const, reasoning: undefined,
          parts: [{ kind: 'toolCall' as const, callId: `pr${primaryCallCount}`, name: 'send_message', args: JSON.stringify({ text: 'should never be sent' }) }],
        }],
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const h = makeReactOnlyHarness();
    const driver = createDriver({ chatIds: ['-100125'], resolveChatConfig: () => makeChatConfig() }, h.deps);

    driver.handleEvent('-100125', buildRC());
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(primaryCallCount).toBe(1);
    expect(JSON.stringify(h.persistedTRs[0]!.entries)).toContain('Unknown tool: send_message');
    expect(h.persistedTRs[0]!.entries.some(entry => entry.kind === 'toolResult' && entry.requiresFollowUp)).toBe(false);
    expect(h.sendMessageCalls).toEqual([]);
    expect(collectUserText(mockCallLlm.mock.calls[1]![1])).toContain('react-or-stay-silent turn');

    // The rejection closed the turn, so the next message still goes through probe.
    driver.handleEvent('-100125', [{
      receivedAtMs: Date.now(),
      senderId: 'user1',
      content: [{ type: 'text', text: '<message id="10" sender="Alice" t="t">hello?</message>' }],
    }]);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(2), { timeout: 1000, interval: 10 });
    expect(mockCallLlm.mock.calls.map(call => call[0]!.model))
      .toEqual(['mock-probe', 'mock-primary', 'mock-probe', 'mock-primary']);

    driver.stop();
  });

  it('feeds participation stats into both late-binding prompts and omits them when inapplicable', async () => {
    mockCallLlm.mockReset();
    mockCallLlm.mockImplementation(async config => ({
      entries: [{
        kind: 'message', role: 'assistant', reasoning: undefined,
        parts: [config.model === 'mock-probe'
          ? { kind: 'toolCall', callId: 'p1', name: 'decide', args: JSON.stringify({ should_act: 'send_message', reason: 'addressed' }) }
          : { kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const now = Date.now();
    const busyRc: RenderedContext = [
      { receivedAtMs: now - 120_000, senderId: 'bot', isMyself: true, isSelfSent: true, content: [{ type: 'text', text: '<message id="a" sender="Me" myself="true" t="t">hi</message>' }] },
      { receivedAtMs: now - 60_000, senderId: 'bot', isMyself: true, isSelfSent: true, content: [{ type: 'text', text: '<message id="b" sender="Me" myself="true" t="t">again</message>' }] },
      { receivedAtMs: now - 30_000, senderId: 'other-bot', isBot: true, content: [{ type: 'text', text: '<message id="c" sender="Naitou" bot="true" t="t">hello</message>' }] },
      { receivedAtMs: now - 10_000, senderId: 'other-bot-2', isBot: true, content: [{ type: 'text', text: '<message id="d" sender="Doudou" bot="true" t="t">hi</message>' }] },
    ];

    const persistedTRs: TurnResponseV2[] = [];

    const driver = createDriver(
      { chatIds: ['-100126'], resolveChatConfig: () => makeChatConfig() },
      {
        name: 'telegram',
        loadTurnResponses: async () => [...persistedTRs],
        loadLastTurnResponse: async () => ([...persistedTRs]).at(-1) ?? null,
        persistTurnResponse: async (_, tr) => { persistedTRs.push(tr); },
        persistProbeResponse: async () => {},
        sendMessage: async () => ({ messageId: '999' }),
        banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
        setMessageReaction: async () => {},
        sendTypingAction: async () => {},
        onDebounceStateChange: () => {},
        loadCompaction: () => null,
        loadLastProbeTime: () => 0,
        persistCompaction: () => {},
        setCompactCursor: () => [],
        getChatTitle: () => 'Test',
        runtimeConfig: { shell: ['/bin/bash', '-c'], writeFile: ['cat'], readFile: ['cat'], writeFileSizeLimit: 1024, readFileSizeLimit: 1024 },
        loadMessageAttachments: () => undefined,
        messageExists: () => true,
        downloadMessageMedia: async () => undefined,
        readOldMessages: () => '',
        resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'k', model: 'mock', apiFormat: 'openai-chat' }),
        backgroundTask: {
          startTask: () => 0,
          killTask: () => ({ ok: true }),
          getActiveTasks: () => [],
          readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
        },
        logger,
      },
    );

    driver.handleEvent('-100126', busyRc);
    await vi.waitFor(() => expect(persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });

    const probeText = collectUserText(mockCallLlm.mock.calls[0]![1]);
    const primaryText = collectUserText(mockCallLlm.mock.calls[1]![1]);
    expect(probeText).toContain('It sent 2 messages in the last 10 minutes.');
    expect(primaryText).toContain('You sent 2 messages in the last 10 minutes.');
    expect(probeText).toContain('4 consecutive messages have come from bots.');
    expect(primaryText).toContain('Bot-to-bot activity');

    // A context with no self messages and no other bots renders neither block.
    mockCallLlm.mockClear();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    driver.handleEvent('-100126', [{
      receivedAtMs: Date.now(),
      senderId: 'user1',
      content: [{ type: 'text', text: '<message id="e" sender="Alice" t="t">hello?</message>' }],
    }]);
    await vi.waitFor(() => expect(mockCallLlm).toHaveBeenCalledTimes(2), { timeout: 1000, interval: 10 });
    const quietProbeText = collectUserText(mockCallLlm.mock.calls[0]![1]);
    const quietPrimaryText = collectUserText(mockCallLlm.mock.calls[1]![1]);
    expect(quietProbeText).not.toContain("The chatbot's recent activity");
    expect(quietPrimaryText).not.toContain('Your recent activity');
    expect(quietPrimaryText).not.toContain('Bot-to-bot activity');

    driver.stop();
  });

  it('probe sees only its recent window while primary still sees the full history', async () => {
    mockCallLlm.mockReset();
    mockCallLlm.mockImplementation(async config => ({
      entries: [{
        kind: 'message', role: 'assistant', reasoning: undefined,
        parts: [config.model === 'mock-probe'
          ? { kind: 'toolCall', callId: 'p1', name: 'decide', args: JSON.stringify({ should_act: 'send_message', reason: 'addressed' }) }
          : { kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
      }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const chatConfig = makeChatConfig();
    chatConfig.probe.contextEstTokens = 1000; // target ≈ 500 estimated tokens
    const h = makeReactOnlyHarness();
    const driver = createDriver({ chatIds: ['-100127'], resolveChatConfig: () => chatConfig }, h.deps);

    // Six ~510-token segments: only the newest fits the probe window.
    const rc: RenderedContext = Array.from({ length: 6 }, (_, i) => ({
      receivedAtMs: (i + 1) * 1000,
      senderId: 'user1',
      content: [{ type: 'text', text: `<message id="${i}" sender="Alice" t="t">history ${i} ${'x'.repeat(1000)}</message>` }],
    }));
    driver.handleEvent('-100127', rc);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });

    const probeText = collectUserText(mockCallLlm.mock.calls[0]![1]);
    const primaryText = collectUserText(mockCallLlm.mock.calls[1]![1]);
    expect(probeText).not.toContain('history 0');
    expect(probeText).toContain('history 5');
    expect(primaryText).toContain('history 0');
    expect(primaryText).toContain('history 5');

    driver.stop();
  });

  it('keeps an unanswered @-mention after a no_action probe and later chatter', async () => {
    mockCallLlm.mockReset();
    let probeCalls = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') {
        probeCalls++;
        return {
          entries: [{
            kind: 'message', role: 'assistant', reasoning: undefined,
            parts: [{
              kind: 'toolCall', callId: `p${probeCalls}`, name: 'decide',
              args: JSON.stringify(probeCalls === 1
                ? { should_act: 'no_action', reason: 'nothing to add yet' }
                : { should_act: 'send_message', reason: 'addressed' }),
            }],
          }],
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }
      return {
        entries: [{
          kind: 'message', role: 'assistant', reasoning: undefined,
          parts: [{ kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
        }],
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });

    const h = makeReactOnlyHarness();
    const driver = createDriver({ chatIds: ['-100128'], resolveChatConfig: () => makeChatConfig() }, h.deps);

    const mention: RenderedContext = [{
      receivedAtMs: Date.now(),
      senderId: 'user1',
      content: [{ type: 'text', text: '<message id="m1" sender="Alice" t="t">@LarkBot please answer me</message>' }],
    }];
    driver.handleEvent('-100128', mention);
    await vi.waitFor(() => expect(h.persistedProbes).toHaveLength(1), { timeout: 1000, interval: 10 });
    expect(h.persistedProbes[0]!.isActivated).toBe(false);

    // Chatter after the no_action probe pushes past the window target, but the
    // @-mention must stay in the mandatory region because the bot has not acted.
    const base = Date.now();
    const chatter: RenderedContext = Array.from({ length: 12 }, (_, i) => ({
      receivedAtMs: base + (i + 1) * 1000,
      senderId: 'user2',
      content: [{ type: 'text', text: `<message id="c${i}" sender="Bob" t="t">${'x'.repeat(2000)}</message>` }],
    }));
    driver.handleEvent('-100128', [...mention, ...chatter]);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });

    const probeCallList = mockCallLlm.mock.calls.filter(c => c[0]!.model === 'mock-probe');
    expect(probeCallList).toHaveLength(2);
    const secondProbeText = collectUserText(probeCallList[1]![1]);
    expect(secondProbeText).toContain('@LarkBot please answer me');

    driver.stop();
  });

  it('keeps an unanswered @-mention after a silent end_turn and later chatter', async () => {
    mockCallLlm.mockReset();
    mockCallLlm.mockImplementation(async config => ({
      entries: [{
        kind: 'message', role: 'assistant', reasoning: undefined,
        parts: [config.model === 'mock-probe'
          ? { kind: 'toolCall', callId: 'p1', name: 'decide', args: JSON.stringify({ should_act: 'send_message', reason: 'addressed' }) }
          : { kind: 'toolCall', callId: 'pr1', name: 'end_turn', args: '{}' }],
      }],
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));

    const h = makeReactOnlyHarness();
    const driver = createDriver({ chatIds: ['-100129'], resolveChatConfig: () => makeChatConfig() }, h.deps);

    const mention: RenderedContext = [{
      receivedAtMs: Date.now(),
      senderId: 'user1',
      content: [{ type: 'text', text: '<message id="m1" sender="Alice" t="t">@LarkBot please answer me</message>' }],
    }];
    driver.handleEvent('-100129', mention);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });
    // The primary turn ended silently: its end_turn-only TR must not count as an action.
    expect(h.persistedTRs[0]!.entries.some(entry =>
      entry.kind === 'message' && entry.role === 'assistant'
      && entry.parts.some(part => part.kind === 'toolCall' && part.name === 'end_turn'))).toBe(true);

    const base = Date.now();
    const chatter: RenderedContext = Array.from({ length: 12 }, (_, i) => ({
      receivedAtMs: base + (i + 1) * 1000,
      senderId: 'user2',
      content: [{ type: 'text', text: `<message id="c${i}" sender="Bob" t="t">${'x'.repeat(2000)}</message>` }],
    }));
    driver.handleEvent('-100129', [...mention, ...chatter]);
    await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(2), { timeout: 1000, interval: 10 });

    const probeCallList = mockCallLlm.mock.calls.filter(c => c[0]!.model === 'mock-probe');
    expect(probeCallList).toHaveLength(2);
    const secondProbeText = collectUserText(probeCallList[1]![1]);
    expect(secondProbeText).toContain('@LarkBot please answer me');

    driver.stop();
  });
  describe('participation limits', () => {
    const limitedConfig = (): ResolvedChatConfig => ({
      ...makeChatConfig(),
      participation: { style: 'normal', brakeMessages10m: 10, cooldownSec: 300, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' },
    });
    const recentRC = (lastMessage: Partial<RenderedContext[number]>): RenderedContext => {
      const now = Date.now();
      return [
        { receivedAtMs: now - 5000, senderId: 'user1', content: [{ type: 'text', text: '<message id="1" sender="Alice" t="t">hello</message>' }] },
        { receivedAtMs: now - 4000, senderId: 'bot', isMyself: true, isSelfSent: true, content: [{ type: 'text', text: '<message id="2" sender="Bot" myself="true" t="t">hi</message>' }] },
        { receivedAtMs: now - 3000, senderId: 'user1', content: [{ type: 'text', text: '<message id="3" sender="Alice" t="t">lol nice</message>' }], ...lastMessage },
      ];
    };

    it('refuses a reaction and tells the probe only a direct address may wake the bot during a cooldown', async () => {
      mockCallLlm.mockReset();
      mockCallLlm.mockImplementation(async config => config.model === 'mock-probe' ? reactOnlyProbe() : primaryReact('r1'));
      const h = makeReactOnlyHarness();
      const driver = createDriver({ chatIds: ['-100130'], resolveChatConfig: limitedConfig }, h.deps);

      driver.handleEvent('-100130', recentRC({}));
      await vi.waitFor(() => expect(h.persistedProbes).toHaveLength(1), { timeout: 1000, interval: 10 });
      await new Promise<void>(resolve => setTimeout(resolve, 20));

      expect(collectUserText(mockCallLlm.mock.calls[0]![1])).toContain('Participation limit reached');
      expect(mockCallLlm.mock.calls.map(call => call[0]!.model)).toEqual(['mock-probe']);
      expect(h.persistedProbes[0]!.isActivated).toBe(false);
      expect(h.reactions).toEqual([]);
      driver.stop();
    });

    it('lets an @-mention bypass the cooldown deterministically', async () => {
      mockCallLlm.mockReset();
      mockCallLlm.mockImplementation(async config => config.model === 'mock-probe' ? reactOnlyProbe() : primaryReact('r1'));
      const h = makeReactOnlyHarness();
      const driver = createDriver({ chatIds: ['-100131'], resolveChatConfig: limitedConfig }, h.deps);

      driver.handleEvent('-100131', recentRC({ mentionsMe: true }));
      await vi.waitFor(() => expect(h.persistedTRs).toHaveLength(1), { timeout: 1000, interval: 10 });

      expect(collectUserText(mockCallLlm.mock.calls[0]![1])).not.toContain('Participation limit reached');
      expect(h.persistedProbes[0]!.isActivated).toBe(true);
      expect(h.reactions).toEqual(['😂']);
      driver.stop();
    });
  });
});

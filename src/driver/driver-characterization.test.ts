import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { createDriver } from './index';
import { createRunner } from './runner';
import { createTool } from './tools/create-tool';
import { DEFAULT_PROBE_TIMEOUT_MS } from './turn-budget';
import { DEFAULT_TURN_BUDGET } from './turn-loop';
import type { ProbeResponseV2, TurnBudget, TurnResponseV2 } from './types';
import { interruptedChainUsage } from './wakeup';
import type { ResolvedChatConfig } from '../config/config';
import type { LlmCallUsage } from '../llm/call';
import { callLlm } from '../llm/call';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import type { RenderedContext } from '../rendering/types';
import type { ConversationEntry } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('driver-characterization-test');
const mockCallLlm = vi.mocked(callLlm);

const makeUsage = (
  inputTokens = 1,
  outputTokens = 1,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): LlmCallUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const toolCallEntries = (callId: string, name: string, args = '{}'): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'toolCall', callId, name, args }],
  reasoning: undefined,
}];

const roundsBudget = (maxToolRounds: number): TurnBudget => ({ ...DEFAULT_TURN_BUDGET, maxToolRounds });

const makeChatConfig = (): ResolvedChatConfig => ({
  primary: {
    model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'mock-primary', apiFormat: 'openai-chat' },
    turnBudget: DEFAULT_TURN_BUDGET,
    reasoningReplayTurns: 3,
  },
  systemFiles: [],
  sendTypingAction: false,
  blockedUserIds: [],
  debounce: { initialDelayMs: 1, typingExtendMs: 1, maxDelayMs: 50 },
  compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
  probe: {
    model: { apiBaseUrl: 'mock', apiKey: 'key', model: 'mock-probe', apiFormat: 'openai-chat' },
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

const buildExternalContext = (receivedAtMs = 1000): RenderedContext => [{
  receivedAtMs,
  senderId: 'user-1',
  content: [{
    type: 'text',
    text: '<message id="1" sender="Alice (@alice)" t="2025-01-01T00:00:01+00:00">hello bot</message>',
  }],
}];

type DriverDeps = Parameters<typeof createDriver>[1];

const makeDriverDeps = (overrides: Partial<DriverDeps> = {}): DriverDeps => ({
  name: 'telegram',
  loadTurnResponses: async () => [],
  loadLastTurnResponse: async () => ([]).at(-1) ?? null,
  persistTurnResponse: async () => {},
  persistProbeResponse: async () => {},
  sendMessage: async () => ({ messageId: '1' }),
  banSpammer: async () => ({ status: 'rejected' as const, reason: 'unknown_message' as const }),
  setMessageReaction: async () => {},
  sendTypingAction: async () => {},
  onDebounceStateChange: () => {},
  loadCompaction: () => null,
  loadLastProbeTime: () => 0,
  persistCompaction: () => {},
  setCompactCursor: () => [],
  getChatTitle: () => 'Test chat',
  runtimeConfig: {
    shell: ['/bin/bash', '-c'],
    writeFile: ['cat'],
    readFile: ['cat'],
    writeFileSizeLimit: 1024,
    readFileSizeLimit: 1024,
  },
  loadMessageAttachments: () => undefined,
  messageExists: () => true,
  downloadMessageMedia: async () => undefined,
  readOldMessages: () => '',
  resolveModel: () => ({ apiBaseUrl: 'mock', apiKey: 'key', model: 'mock', apiFormat: 'openai-chat' }),
  backgroundTask: {
    startTask: () => 0,
    killTask: () => ({ ok: true }),
    getActiveTasks: () => [],
    readTaskOutput: async () => ({ content: '', totalLines: 0, truncated: false }),
  },
  logger,
  ...overrides,
});

const activeDrivers: ReturnType<typeof createDriver>[] = [];

const startDriver = (chatId: string, deps: DriverDeps) => {
  const driver = createDriver({
    chatIds: [chatId],
    resolveChatConfig: () => makeChatConfig(),
  }, deps);
  activeDrivers.push(driver);
  return driver;
};

beforeEach(() => {
  mockCallLlm.mockReset();
});

afterEach(() => {
  for (const driver of activeDrivers) driver.stop();
  activeDrivers.length = 0;
});

describe('Driver probe gate characterization', () => {
  const failClosedCases: { name: string; entries: ConversationEntry[] }[] = [
    {
      name: 'no decide call',
      entries: [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'I would answer.' }],
        reasoning: undefined,
      }],
    },
    {
      name: 'invalid decide arguments',
      entries: toolCallEntries('probe-invalid', 'decide', JSON.stringify({ should_act: 'send_message' })),
    },
  ];

  it.each(failClosedCases)('fails closed on $name and persists the rejected probe', async ({ entries }) => {
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const sendMessage = vi.fn(async () => ({ messageId: '1' }));
    const probeUsage = makeUsage(11, 7, 3, 2);
    mockCallLlm.mockResolvedValue({ entries, usage: probeUsage });

    const driver = startDriver('probe-fail-closed', makeDriverDeps({
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      sendMessage,
    }));

    driver.handleEvent('probe-fail-closed', buildExternalContext());

    await vi.waitFor(() => expect(persistedProbes).toHaveLength(1), { timeout: 2000 });

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(mockCallLlm.mock.calls[0]![0]).toMatchObject({
      model: 'mock-probe',
      forceToolChoice: { name: 'decide' },
    });
    expect(persistedProbes[0]).toMatchObject({
      entries,
      ...probeUsage,
      modelName: 'mock-probe',
      isActivated: false,
    });
    expect(persistedTurns).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('persists no_action and advances the watermark without invoking primary', async () => {
    const entries = toolCallEntries('probe-no-action', 'decide', JSON.stringify({
      should_act: 'no_action',
      reason: 'The exchange is already complete.',
    }));
    const probeUsage = makeUsage(13, 5, 2, 0);
    const persistedProbes: ProbeResponseV2[] = [];
    const persistedTurns: TurnResponseV2[] = [];
    const onDebounceStateChange = vi.fn();
    let probePersisted = false;
    let loadsAfterProbePersistence = 0;

    mockCallLlm.mockResolvedValue({ entries, usage: probeUsage });

    const driver = startDriver('probe-no-action', makeDriverDeps({
      loadTurnResponses: async () => {
        if (probePersisted) loadsAfterProbePersistence++;
        return persistedTurns;
      },
      // The startup single-row path must share the mock's counter, so it can be
      // observed just like the full-table path.
      loadLastTurnResponse: async () => {
        if (probePersisted) loadsAfterProbePersistence++;
        return persistedTurns.at(-1) ?? null;
      },
      persistProbeResponse: async (_chatId, probe) => {
        persistedProbes.push(probe);
        probePersisted = true;
      },
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      onDebounceStateChange,
    }));

    driver.handleEvent('probe-no-action', buildExternalContext());

    await vi.waitFor(() => expect(persistedProbes).toHaveLength(1), { timeout: 2000 });
    await vi.waitFor(() => expect(loadsAfterProbePersistence).toBeGreaterThan(0), { timeout: 2000 });

    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(persistedProbes[0]).toMatchObject({
      entries,
      ...probeUsage,
      modelName: 'mock-probe',
      isActivated: false,
    });
    expect(persistedTurns).toEqual([]);

    await new Promise<void>(resolve => setImmediate(resolve));
    onDebounceStateChange.mockClear();
    mockCallLlm.mockClear();

    driver.handleEvent(
      'probe-no-action',
      buildExternalContext(persistedProbes[0]!.requestedAtMs),
    );

    await new Promise<void>(resolve => setTimeout(resolve, 25));
    expect(onDebounceStateChange).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(persistedProbes).toHaveLength(1);
  });
});

describe('Probe timeout and wake-up liveness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Wake-ups mix fake timers (debounce, backoff) with real I/O (prompt files),
  // so step fake time and yield to the real event loop alternately.
  const advanceUntil = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !condition(); i++) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  const activate = () => ({
    entries: toolCallEntries('probe', 'decide', JSON.stringify({ should_act: 'send_message', reason: 'probe-reason-marker' })),
    usage: makeUsage(),
  });

  it('bounds probe by probe.timeoutMs and starts the primary deadline after probe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const persistedTurns: TurnResponseV2[] = [];
    mockCallLlm.mockImplementation(async config => {
      if (config.model !== 'mock-probe') return { entries: toolCallEntries('end', 'end_turn'), usage: makeUsage() };
      // A slow but successful probe must not shorten the primary budget.
      vi.setSystemTime(Date.now() + 12_000);
      return activate();
    });
    const chatConfig = makeChatConfig();
    chatConfig.probe.model.timeoutSec = 60;
    const driver = createDriver({ chatIds: ['probe-timeout'], resolveChatConfig: () => chatConfig }, makeDriverDeps({
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
    }));
    activeDrivers.push(driver);
    driver.handleEvent('probe-timeout', buildExternalContext());

    await vi.waitFor(() => expect(persistedTurns).toHaveLength(1), { timeout: 2000 });
    expect(mockCallLlm.mock.calls[0]![0]).toMatchObject({ model: 'mock-probe', timeoutSec: DEFAULT_PROBE_TIMEOUT_MS / 1000 });
    const primaryTimeoutSec = mockCallLlm.mock.calls[1]![0].timeoutSec!;
    expect(primaryTimeoutSec).toBeGreaterThan(DEFAULT_TURN_BUDGET.deadlineMs / 1000 - 1);
    expect(primaryTimeoutSec).toBeLessThanOrEqual(DEFAULT_TURN_BUDGET.deadlineMs / 1000);
  });

  it('retries a timed-out probe on the same context instead of waiting for new input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const persistedTurns: TurnResponseV2[] = [];
    let probeCalls = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model !== 'mock-probe') return { entries: toolCallEntries('end', 'end_turn'), usage: makeUsage() };
      probeCalls++;
      if (probeCalls === 1) throw new Error('chat request timed out after 15s');
      return activate();
    });
    startDriver('probe-retry', makeDriverDeps({
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
    })).handleEvent('probe-retry', buildExternalContext());

    await advanceUntil(() => persistedTurns.length > 0);
    expect(persistedTurns).toHaveLength(1);
    expect(probeCalls).toBe(2);
  });

  it('retries a transiently failed primary straight away, reusing the probe activation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const persistedTurns: TurnResponseV2[] = [];
    const persistedProbes: ProbeResponseV2[] = [];
    let primaryCalls = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') return activate();
      primaryCalls++;
      if (primaryCalls === 1) throw new Error('Chat Completions API 503: busy');
      return { entries: toolCallEntries('end', 'end_turn'), usage: makeUsage() };
    });
    startDriver('primary-retry', makeDriverDeps({
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
    })).handleEvent('primary-retry', buildExternalContext());

    await advanceUntil(() => persistedTurns.length > 0);
    expect(persistedTurns).toHaveLength(1);
    expect(primaryCalls).toBe(2);
    expect(mockCallLlm.mock.calls.filter(([config]) => config.model === 'mock-probe')).toHaveLength(1);
    expect(persistedProbes).toHaveLength(1);
    // The retried primary still receives the original probe reason.
    expect(JSON.stringify(mockCallLlm.mock.calls[1]![1])).toContain('probe-reason-marker');
    expect(JSON.stringify(mockCallLlm.mock.calls[2]![1])).toContain('probe-reason-marker');
  });

  it('resumes a mid-chain transient failure without probe and with the chain budget carried over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const persistedTurns: TurnResponseV2[] = [];
    const readOld = (callId: string) => ({
      entries: toolCallEntries(callId, 'read_old_messages', JSON.stringify({ message_ids: ['1'] })),
      usage: makeUsage(),
    });
    let primaryCalls = 0;
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') return activate();
      primaryCalls++;
      if (primaryCalls === 1) return readOld('read-1');
      if (primaryCalls === 2) throw new Error('Messages API 529: overloaded');
      if (primaryCalls === 3) return readOld('read-2');
      return { entries: toolCallEntries('end', 'end_turn'), usage: makeUsage() };
    });
    startDriver('mid-chain-retry', makeDriverDeps({
      loadTurnResponses: async () => [...persistedTurns],
      loadLastTurnResponse: async () => ([...persistedTurns]).at(-1) ?? null,
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      readOldMessages: () => '<message id="1">old</message>',
    })).handleEvent('mid-chain-retry', buildExternalContext());

    await advanceUntil(() => persistedTurns.length >= 3);
    expect(persistedTurns).toHaveLength(3);
    const models = mockCallLlm.mock.calls.map(([config]) => config.model);
    expect(models).toEqual(['mock-probe', 'mock-primary', 'mock-primary', 'mock-primary', 'mock-primary']);
    const toolNames = (call: number) => mockCallLlm.mock.calls[call]![3]?.map(schema => schema.name);
    expect(toolNames(3)).toContain('read_old_messages');
    // Round 1 before the failure plus round 2 in the retry exhaust
    // maxToolRounds = 2, so the next step is the participation-only wrap-up.
    expect(toolNames(4)).toEqual(['send_message', 'react', 'end_turn']);
    expect(persistedTurns[2]!.entries.some(entry => entry.kind === 'toolResult' && entry.requiresFollowUp)).toBe(false);
  });

  it('does not retry a permanent model error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockCallLlm.mockRejectedValue(new Error('Chat Completions API 401: bad key'));
    startDriver('permanent-error', makeDriverDeps()).handleEvent('permanent-error', buildExternalContext());

    await advanceUntil(() => mockCallLlm.mock.calls.length > 0);
    // Long enough for every default retry delay to elapse.
    await advanceUntil(() => false);
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
  });
});

const workTurn = (requestedAtMs: number, requiresFollowUp: boolean, name = 'bash'): TurnResponseV2 => ({
  requestedAtMs,
  modelName: 'mock-primary',
  shellToolsExposed: true,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  entries: [
    ...toolCallEntries(`call-${requestedAtMs}`, name),
    { kind: 'toolResult', callId: `call-${requestedAtMs}`, payload: '{}', requiresFollowUp },
  ],
});

describe('Turn budget across interruption chains', () => {
  it('counts only the open chain after the last closed turn', () => {
    expect(interruptedChainUsage([
      workTurn(100, true),
      workTurn(200, false),
      workTurn(300, true),
      workTurn(400, true, 'send_message'),
    ])).toEqual({ toolRounds: 2, toolCalls: 1, participationCalls: 1 });
  });

  it('continues an exhausted chain without probe at the wrap-up, then gives a new topic a fresh probe and budget', async () => {
    const persistedTurns: TurnResponseV2[] = [workTurn(500, true), workTurn(600, true)];
    const persistedProbes: ProbeResponseV2[] = [];
    mockCallLlm.mockImplementation(async config => config.model === 'mock-probe'
      ? {
          entries: toolCallEntries('probe', 'decide', JSON.stringify({ should_act: 'send_message', reason: 'new topic' })),
          usage: makeUsage(),
        }
      : { entries: toolCallEntries(`end-${mockCallLlm.mock.calls.length}`, 'end_turn'), usage: makeUsage() });

    const driver = startDriver('chain-budget', makeDriverDeps({
      loadTurnResponses: async () => [...persistedTurns],
      loadLastTurnResponse: async () => ([...persistedTurns]).at(-1) ?? null,
      persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); },
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
      loadLastProbeTime: () => 0,
    }));
    driver.handleEvent('chain-budget', buildExternalContext(1000));

    await vi.waitFor(() => expect(persistedTurns).toHaveLength(3), { timeout: 2000 });
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(mockCallLlm.mock.calls[0]![0].model).toBe('mock-primary');
    expect(mockCallLlm.mock.calls[0]![3]?.map(schema => schema.name)).toEqual(['send_message', 'react', 'end_turn']);
    expect(persistedTurns[2]!.entries.some(entry => entry.kind === 'toolResult' && entry.requiresFollowUp)).toBe(false);
    expect(persistedProbes).toEqual([]);

    driver.handleEvent('chain-budget', [
      ...buildExternalContext(1000),
      {
        receivedAtMs: Date.now() + 1,
        senderId: 'user-2',
        content: [{ type: 'text', text: '<message id="2" sender="Bob (@bob)" t="2025-01-01T00:00:02+00:00">unrelated topic</message>' }],
      },
    ]);

    await vi.waitFor(() => expect(persistedTurns).toHaveLength(4), { timeout: 2000 });
    expect(persistedProbes).toHaveLength(1);
    expect(mockCallLlm.mock.calls[1]![0].model).toBe('mock-probe');
    expect(mockCallLlm.mock.calls[2]![3]?.map(schema => schema.name)).toContain('bash');
  });
});

describe('Runner persistence and force-tool characterization', () => {
  const createTestRunner = () => createRunner({
    apiBaseUrl: 'mock',
    apiKey: 'key',
    model: 'mock-primary',
    apiFormat: 'openai-chat',
  });

  const initialEntries: ConversationEntry[] = [{
    kind: 'message',
    role: 'user',
    parts: [{ kind: 'text', text: 'continue' }],
  }];

  it('checks a cooperative interrupt only after the completed step is persisted', async () => {
    const order: string[] = [];
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>(resolve => { resolvePersistence = resolve; });
    const continuationTool = createTool({
      name: 'continue_work',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        order.push('tool');
        return { content: 'continue', requiresFollowUp: true };
      },
    });
    const modelEntries = toolCallEntries('continue-1', 'continue_work');
    const usage = makeUsage(8, 3);
    mockCallLlm.mockResolvedValue({ entries: modelEntries, usage });

    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {
      order.push('persist:start');
      await persistence;
      order.push('persist:end');
    });
    const checkInterrupt = vi.fn(() => {
      order.push('interrupt');
      return true;
    });

    const runPromise = createTestRunner().runStepLoop({
      chatId: 'interrupt-order',
      entries: initialEntries,
      system: 'system',
      tools: [continuationTool],
      budget: roundsBudget(2),
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    await vi.waitFor(() => expect(onStepComplete).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['tool', 'persist:start']);
    expect(checkInterrupt).not.toHaveBeenCalled();

    resolvePersistence();
    await runPromise;

    expect(order).toEqual(['tool', 'persist:start', 'persist:end', 'interrupt']);
    expect(checkInterrupt).toHaveBeenCalledTimes(1);
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
    expect(onStepComplete.mock.calls[0]![0]).toEqual([
      ...modelEntries,
      {
        kind: 'toolResult',
        callId: 'continue-1',
        payload: 'continue',
        requiresFollowUp: true,
      },
    ]);
  });

  it('retries a named force-tool choice without executing or persisting rejected attempts', async () => {
    const rejectedExecute = vi.fn(() => ({ content: 'ended', requiresFollowUp: false }));
    const sendExecute = vi.fn(() => ({ content: 'sent', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: rejectedExecute,
    });
    const sendTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: sendExecute,
    });
    const rejectedEntries = toolCallEntries('rejected-1', 'end_turn');
    const acceptedEntries = toolCallEntries('accepted-1', 'send_message');
    mockCallLlm
      .mockResolvedValueOnce({ entries: rejectedEntries, usage: makeUsage(1, 2, 3, 4) })
      .mockResolvedValueOnce({ entries: acceptedEntries, usage: makeUsage(10, 20, 30, 40) });
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {});
    const checkInterrupt = vi.fn(() => false);

    await createTestRunner().runStepLoop({
      chatId: 'named-force-tool',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, sendTool],
      budget: roundsBudget(1),
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls.map(call => call[0].forceToolChoice)).toEqual([
      { name: 'send_message' },
      { name: 'send_message' },
    ]);
    expect(mockCallLlm.mock.calls.map(call => call[1])).toEqual([
      initialEntries,
      initialEntries,
    ]);
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(sendExecute).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
    expect(onStepComplete.mock.calls[0]![0]).toEqual([
      ...acceptedEntries,
      {
        kind: 'toolResult',
        callId: 'accepted-1',
        payload: 'sent',
        requiresFollowUp: false,
      },
    ]);
    expect(onStepComplete.mock.calls[0]![1]).toEqual(makeUsage(11, 22, 33, 44));
    expect(checkInterrupt).not.toHaveBeenCalled();
  });

  it('fails without executing or persisting after force-tool retries are exhausted', async () => {
    const rejectedExecute = vi.fn((_input: unknown) => ({ content: 'wrong tool', requiresFollowUp: false }));
    const sendExecute = vi.fn(() => ({ content: 'sent', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: {
        type: 'object',
        properties: { attempt: { type: 'number' } },
        required: ['attempt'],
      },
      execute: rejectedExecute,
    });
    const sendTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: sendExecute,
    });
    let attempt = 0;
    mockCallLlm.mockImplementation(async () => {
      attempt++;
      return {
        entries: toolCallEntries(`rejected-${attempt}`, 'end_turn', JSON.stringify({ attempt })),
        usage: makeUsage(1, 1, 1, 1),
      };
    });
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {});

    await expect(createTestRunner().runStepLoop({
      chatId: 'exhausted-force-tool',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, sendTool],
      budget: roundsBudget(1),
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    })).rejects.toThrow('did not satisfy forced tool choice');

    expect(mockCallLlm).toHaveBeenCalledTimes(4);
    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(sendExecute).not.toHaveBeenCalled();
    expect(onStepComplete).not.toHaveBeenCalled();
  });
});

describe('Wake-up failure attribution and watchdog rearm', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const advanceUntil = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !condition(); i++) {
      await vi.advanceTimersByTimeAsync(500);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  const activate = () => ({
    entries: toolCallEntries('probe', 'decide', JSON.stringify({ should_act: 'send_message', reason: 'r' })),
    usage: makeUsage(),
  });

  it('tags exhausted probe timeouts as probe-stage timeouts, not primary failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockCallLlm.mockImplementation(async () => { throw new Error('chat request timed out after 15s'); });
    const driver = startDriver('attr-probe-timeout', makeDriverDeps());
    driver.handleEvent('attr-probe-timeout', buildExternalContext());

    // Three attempts (initial + 5 s + 20 s), then abandoned.
    await advanceUntil(() => driver.wakeupCounters('attr-probe-timeout')?.abandoned === 1);
    expect(driver.wakeupCounters('attr-probe-timeout')).toMatchObject({
      probeTimeouts: 3,
      probeFailures: 0,
      primaryFailures: 0,
      abandoned: 1,
    });
  });

  it('tags a permanent primary error as a primary failure after a successful probe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockCallLlm.mockImplementation(async config => {
      if (config.model === 'mock-probe') return activate();
      throw new Error('Chat Completions API 400: bad request');
    });
    const driver = startDriver('attr-primary', makeDriverDeps());
    driver.handleEvent('attr-primary', buildExternalContext());

    await advanceUntil(() => driver.wakeupCounters('attr-primary')?.abandoned === 1);
    expect(driver.wakeupCounters('attr-primary')).toMatchObject({
      probeTimeouts: 0,
      probeFailures: 0,
      primaryFailures: 1,
      abandoned: 1,
    });
  });

  it('counts a malformed probe decision, which still fails closed without an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mockCallLlm.mockResolvedValue({ entries: toolCallEntries('probe', 'decide', '{"nope":1}'), usage: makeUsage() });
    const persistedProbes: ProbeResponseV2[] = [];
    const driver = startDriver('attr-malformed', makeDriverDeps({
      persistProbeResponse: async (_chatId, probe) => { persistedProbes.push(probe); },
    }));
    driver.handleEvent('attr-malformed', buildExternalContext());

    await advanceUntil(() => persistedProbes.length > 0);
    expect(persistedProbes[0]!.isActivated).toBe(false);
    expect(driver.wakeupCounters('attr-malformed')).toMatchObject({ probeMalformed: 1, abandoned: 0, primaryFailures: 0 });
  });

  it('rearms an abandoned wake-up from the watchdog once the stuck time has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let healthy = false;
    mockCallLlm.mockImplementation(async config => {
      if (!healthy) throw new Error('Chat Completions API 400: bad request');
      return config.model === 'mock-probe' ? activate() : { entries: toolCallEntries('end', 'end_turn'), usage: makeUsage() };
    });
    const persistedTurns: TurnResponseV2[] = [];
    const driver = createDriver({
      chatIds: ['rearm'],
      resolveChatConfig: () => makeChatConfig(),
      watchdog: { enabled: true, intervalSec: 60, rearmAfterSec: 600, failureStreakThreshold: 3, summaryIntervalSec: 900 },
    }, makeDriverDeps({ persistTurnResponse: async (_chatId, turn) => { persistedTurns.push(turn); } }));
    activeDrivers.push(driver);
    driver.start();
    driver.start();
    driver.handleEvent('rearm', buildExternalContext());

    await advanceUntil(() => driver.wakeupCounters('rearm')?.abandoned === 1);
    expect(persistedTurns).toHaveLength(0);
    // Silent chat, provider recovers: nothing happens until the watchdog's rearm age.
    healthy = true;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(persistedTurns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await advanceUntil(() => persistedTurns.length > 0);
    expect(persistedTurns).toHaveLength(1);
    expect(driver.wakeupCounters('rearm')).toMatchObject({ abandoned: 1 });
  });
});

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm/call', () => ({ callLlm: vi.fn() }));

import { createRunner } from './runner';
import { createTool } from './tools/create-tool';
import { isTransientModelError } from './transient-error';
import { DEFAULT_TURN_BUDGET } from './turn-loop';
import type { TurnBudget } from './types';
import { callLlm, type LlmCallUsage } from '../llm/call';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('runner-test');
const mockCallLlm = vi.mocked(callLlm);

const makeUsage = (
  inputTokens = 1,
  outputTokens = 1,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): LlmCallUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const toolCallEntries = (
  ...calls: { callId: string; name: string; args?: string }[]
): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: calls.map(call => ({
    kind: 'toolCall' as const,
    callId: call.callId,
    name: call.name,
    args: call.args ?? '{}',
  })),
  reasoning: undefined,
}];

const textEntries = (text: string): ConversationEntry[] => [{
  kind: 'message',
  role: 'assistant',
  parts: [{ kind: 'text', text }],
  reasoning: undefined,
}];

const initialEntries: ConversationEntry[] = [{
  kind: 'message',
  role: 'user',
  parts: [{ kind: 'text', text: 'start' }],
}];

const roundsBudget = (maxToolRounds: number): TurnBudget => ({ ...DEFAULT_TURN_BUDGET, maxToolRounds });

const createTestRunner = () => createRunner({
  apiBaseUrl: 'mock',
  apiKey: 'key',
  model: 'mock-model',
  apiFormat: 'openai-chat',
});

beforeEach(() => {
  mockCallLlm.mockReset();
});

describe('runner step operations', () => {
  it('accumulates forced retry usage and executes only the selected model response', async () => {
    const rejectedExecute = vi.fn(() => ({ content: 'rejected', requiresFollowUp: false }));
    const selectedExecute = vi.fn(() => ({ content: 'selected', requiresFollowUp: false }));
    const rejectedTool = createTool({
      name: 'end_turn',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: rejectedExecute,
    });
    const selectedTool = createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: selectedExecute,
    });
    const rejectedEntries = toolCallEntries({ callId: 'rejected', name: 'end_turn' });
    const selectedEntries = toolCallEntries({ callId: 'selected', name: 'send_message' });

    mockCallLlm
      .mockResolvedValueOnce({ entries: rejectedEntries, usage: makeUsage(1, 2, 3, 4) })
      .mockResolvedValueOnce({ entries: selectedEntries, usage: makeUsage(10, 20, 30, 40) });

    const runner = createTestRunner();
    const onStepComplete = vi.fn(async () => {});
    await runner.runStepLoop({
      chatId: 'operation-boundary',
      entries: initialEntries,
      system: 'system',
      tools: [rejectedTool, selectedTool],
      budget: roundsBudget(1),
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: { name: 'send_message' },
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(rejectedExecute).not.toHaveBeenCalled();
    expect(selectedExecute).toHaveBeenCalledOnce();
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls.map(call => call[1])).toEqual([
      initialEntries,
      initialEntries,
    ]);
    expect(mockCallLlm.mock.calls.map(call => call[4]?.label)).toEqual(['step:1', 'step:1']);
    expect(onStepComplete).toHaveBeenCalledWith(
      [
        ...selectedEntries,
        {
          kind: 'toolResult',
          callId: 'selected',
          payload: 'selected',
          requiresFollowUp: false,
        },
      ],
      makeUsage(11, 22, 33, 44),
      expect.any(Number),
    );
  });
});

describe('runner turn loop', () => {
  it('persists empty model output with its usage', async () => {
    const usage = makeUsage(5, 0, 2, 1);
    mockCallLlm.mockResolvedValue({ entries: [], usage });
    const onStepComplete = vi.fn(async () => {});
    const checkInterrupt = vi.fn(() => true);

    await createTestRunner().runStepLoop({
      chatId: 'empty-output',
      entries: initialEntries,
      system: 'system',
      tools: [],
      budget: roundsBudget(3),
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(onStepComplete).toHaveBeenCalledWith([], usage, expect.any(Number));
    expect(checkInterrupt).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledOnce();
  });

  it('continues when any tool result requires follow-up and appends the completed step', async () => {
    const stopTool = createTool({
      name: 'stop_here',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'stopped', requiresFollowUp: false }),
    });
    const continueTool = createTool({
      name: 'continue_work',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'continuing', requiresFollowUp: true }),
    });
    const firstModelEntries = toolCallEntries(
      { callId: 'stop-1', name: 'stop_here' },
      { callId: 'continue-1', name: 'continue_work' },
    );
    const firstStepEntries: ConversationEntry[] = [
      ...firstModelEntries,
      {
        kind: 'toolResult',
        callId: 'stop-1',
        payload: 'stopped',
        requiresFollowUp: false,
      },
      {
        kind: 'toolResult',
        callId: 'continue-1',
        payload: 'continuing',
        requiresFollowUp: true,
      },
    ];
    const finalEntries = textEntries('done');
    mockCallLlm
      .mockResolvedValueOnce({ entries: firstModelEntries, usage: makeUsage(2, 3) })
      .mockResolvedValueOnce({ entries: finalEntries, usage: makeUsage(4, 5) });
    const order: string[] = [];
    const onStepComplete = vi.fn(async (
      _stepEntries: ConversationEntry[],
      _usage: LlmCallUsage,
      _requestedAtMs: number,
    ) => {
      order.push('persist');
    });
    const checkInterrupt = vi.fn(() => {
      order.push('interrupt');
      return false;
    });

    await createTestRunner().runStepLoop({
      chatId: 'follow-up',
      entries: initialEntries,
      system: 'system',
      tools: [stopTool, continueTool],
      budget: roundsBudget(2),
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(order).toEqual(['persist', 'interrupt', 'persist']);
    expect(checkInterrupt).toHaveBeenCalledOnce();
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(mockCallLlm.mock.calls[1]?.[1]).toEqual([
      ...initialEntries,
      ...firstStepEntries,
    ]);
    expect(onStepComplete.mock.calls[0]?.[0]).toEqual(firstStepEntries);
    expect(onStepComplete.mock.calls[1]?.[0]).toEqual(finalEntries);
  });

  it('stops without checking interruption when no tool result requires follow-up', async () => {
    const tool = createTool({
      name: 'finish',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: 'finished', requiresFollowUp: false }),
    });
    mockCallLlm.mockResolvedValue({
      entries: toolCallEntries({ callId: 'finish-1', name: 'finish' }),
      usage: makeUsage(),
    });
    const onStepComplete = vi.fn(async () => {});
    const checkInterrupt = vi.fn(() => false);

    await createTestRunner().runStepLoop({
      chatId: 'no-follow-up',
      entries: initialEntries,
      system: 'system',
      tools: [tool],
      budget: roundsBudget(3),
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(checkInterrupt).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledOnce();
  });
});

describe('required tool call (issue #37)', () => {
  const sendTool = (execute = vi.fn(() => ({ content: '{"ok":true}', requiresFollowUp: false }))) => ({
    tool: createTool({
      name: 'send_message',
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute,
    }),
    execute,
  });
  const endTurnTool = createTool({
    name: 'end_turn',
    description: 'Test tool.',
    parameters: { type: 'object', properties: {} },
    execute: () => ({ content: '{"ok":true}', requiresFollowUp: false }),
  });
  const run = (tools: ReturnType<typeof createTool>[], onStepComplete: () => Promise<void>, log = logger) =>
    createTestRunner().runStepLoop({
      chatId: 'required-tool-call',
      entries: initialEntries,
      system: 'system',
      tools,
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: 'any',
      sendToolChoice: false,
      onStepComplete,
      checkInterrupt: () => false,
      log,
    });

  it('retries a text-only reply on an endpoint that is never sent tool_choice', async () => {
    const send = sendTool();
    const sent = toolCallEntries({ callId: 'send', name: 'send_message', args: '{"text":"hello"}' });
    mockCallLlm
      .mockResolvedValueOnce({ entries: textEntries('hello'), usage: makeUsage(5, 6) })
      .mockResolvedValueOnce({ entries: sent, usage: makeUsage(7, 8) });
    const onStepComplete = vi.fn(async () => {});

    await run([send.tool, endTurnTool], onStepComplete);

    expect(mockCallLlm.mock.calls.map(call => call[0].forceToolChoice)).toEqual([undefined, undefined]);
    expect(send.execute).toHaveBeenCalledOnce();
    // The discarded text is never persisted, so it cannot teach later turns
    // that plain text is a way to speak.
    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(onStepComplete).toHaveBeenCalledWith(
      [...sent, { kind: 'toolResult', callId: 'send', payload: '{"ok":true}', requiresFollowUp: false }],
      makeUsage(12, 14),
      expect.any(Number),
    );
  });

  it('fails the wake-up instead of dropping the reply when every attempt is text-only', async () => {
    const send = sendTool();
    mockCallLlm.mockResolvedValue({ entries: textEntries('hello'), usage: makeUsage() });
    const onStepComplete = vi.fn(async () => {});

    await expect(run([send.tool, endTurnTool], onStepComplete))
      .rejects.toThrow('Model did not satisfy forced tool choice after 4 attempts');

    expect(mockCallLlm).toHaveBeenCalledTimes(4);
    expect(send.execute).not.toHaveBeenCalled();
    expect(onStepComplete).not.toHaveBeenCalled();
  });

  it('warns when text sits beside end_turn without send_message, and still ends the turn', async () => {
    const send = sendTool();
    const warn = vi.fn();
    const spyLog = { withFields: () => spyLog, withError: () => spyLog, warn, log: vi.fn(), debug: vi.fn() };
    mockCallLlm.mockResolvedValue({
      entries: [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'a reply nobody sees' }, { kind: 'toolCall', callId: 'end', name: 'end_turn', args: '{}' }],
        reasoning: undefined,
      }],
      usage: makeUsage(),
    });
    const onStepComplete = vi.fn(async () => {});

    await run([send.tool, endTurnTool], onStepComplete, spyLog as unknown as typeof logger);

    expect(mockCallLlm).toHaveBeenCalledOnce();
    expect(send.execute).not.toHaveBeenCalled();
    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Model wrote text beside end_turn without send_message; the text is not sent');
  });

  it('does not warn about that text when send_message is not offered (react_only)', async () => {
    const warn = vi.fn();
    const spyLog = { withFields: () => spyLog, withError: () => spyLog, warn, log: vi.fn(), debug: vi.fn() };
    mockCallLlm.mockResolvedValue({
      entries: [{
        kind: 'message',
        role: 'assistant',
        parts: [{ kind: 'text', text: 'note' }, { kind: 'toolCall', callId: 'end', name: 'end_turn', args: '{}' }],
        reasoning: undefined,
      }],
      usage: makeUsage(),
    });

    await run([endTurnTool], vi.fn(async () => {}), spyLog as unknown as typeof logger);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('runner turn budget', () => {
  const workTool = (name: string, execute = vi.fn(() => ({ content: name, requiresFollowUp: true }))) => ({
    tool: createTool({
      name,
      description: 'Test tool.',
      parameters: { type: 'object', properties: {} },
      execute,
    }),
    execute,
  });
  const participationTools = () => ({
    send: workTool('send_message', vi.fn(() => ({ content: '{"ok":true}', requiresFollowUp: false }))),
    react: workTool('react', vi.fn(() => ({ content: '{"ok":true}', requiresFollowUp: true }))),
    endTurn: workTool('end_turn', vi.fn(() => ({ content: '{"ok":true}', requiresFollowUp: false }))),
  });
  const schemaNames = (callIndex: number) =>
    mockCallLlm.mock.calls[callIndex]?.[3]?.map(schema => schema.name);
  const persistedResults = (onStepComplete: { mock: { calls: unknown[][] } }, stepIndex: number): ToolResult[] =>
    (onStepComplete.mock.calls[stepIndex]?.[0] as ConversationEntry[])
      .filter((entry): entry is ToolResult => entry.kind === 'toolResult');

  it('ends silently on end_turn without any forced send', async () => {
    const { send, react, endTurn } = participationTools();
    mockCallLlm.mockResolvedValue({ entries: toolCallEntries({ callId: 'end', name: 'end_turn' }), usage: makeUsage() });
    const onStepComplete = vi.fn(async () => {});

    await createTestRunner().runStepLoop({
      chatId: 'silence',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: 'any',
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledOnce();
    expect(mockCallLlm.mock.calls[0]?.[0].forceToolChoice).toBe('any');
    expect(send.execute).not.toHaveBeenCalled();
    expect(onStepComplete).toHaveBeenCalledOnce();
  });

  it('completes a reaction-only turn with react then end_turn', async () => {
    const { send, react, endTurn } = participationTools();
    mockCallLlm
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'r', name: 'react' }), usage: makeUsage() })
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'e', name: 'end_turn' }), usage: makeUsage() });
    const onStepComplete = vi.fn(async () => {});

    await createTestRunner().runStepLoop({
      chatId: 'react-then-end',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(react.execute).toHaveBeenCalledOnce();
    expect(send.execute).not.toHaveBeenCalled();
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
    expect(onStepComplete).toHaveBeenCalledTimes(2);
  });

  it('closes the turn when end_turn is called beside a follow-up result', async () => {
    const { send, react, endTurn } = participationTools();
    mockCallLlm.mockResolvedValue({
      entries: toolCallEntries({ callId: 'r', name: 'react' }, { callId: 'e', name: 'end_turn' }),
      usage: makeUsage(),
    });
    const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});
    const checkInterrupt = vi.fn(() => false);

    await createTestRunner().runStepLoop({
      chatId: 'parallel-react-end',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt,
      log: logger,
    });

    expect(react.execute).toHaveBeenCalledOnce();
    expect(mockCallLlm).toHaveBeenCalledOnce();
    expect(checkInterrupt).not.toHaveBeenCalled();
    expect(persistedResults(onStepComplete, 0).every(result => !result.requiresFollowUp)).toBe(true);
  });

  it('stops new tool rounds at the cap and runs one participation-only wrap-up', async () => {
    const { send, react, endTurn } = participationTools();
    const bash = workTool('bash');
    mockCallLlm
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'b1', name: 'bash' }), usage: makeUsage() })
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'b2', name: 'bash' }), usage: makeUsage() })
      .mockResolvedValueOnce({
        entries: toolCallEntries({ callId: 'b3', name: 'bash' }, { callId: 'r', name: 'react' }),
        usage: makeUsage(),
      });
    const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});

    await createTestRunner().runStepLoop({
      chatId: 'round-cap',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, bash.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      forceToolChoice: 'any',
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledTimes(3);
    expect(schemaNames(0)).toEqual(['send_message', 'react', 'bash', 'end_turn']);
    expect(schemaNames(2)).toEqual(['send_message', 'react', 'end_turn']);
    // The wrap-up's stray work call is answered without running.
    expect(bash.execute).toHaveBeenCalledTimes(2);
    expect(react.execute).toHaveBeenCalledOnce();
    const wrapUpResults = persistedResults(onStepComplete, 2);
    expect(wrapUpResults.find(result => result.callId === 'b3')?.payload).toContain('budget');
    expect(wrapUpResults.every(result => !result.requiresFollowUp)).toBe(true);
  });

  it('executes parallel work calls only up to the call cap', async () => {
    const { send, react, endTurn } = participationTools();
    const search = workTool('web_search');
    mockCallLlm
      .mockResolvedValueOnce({
        entries: toolCallEntries(
          { callId: 's1', name: 'web_search' },
          { callId: 's2', name: 'web_search' },
          { callId: 'm', name: 'send_message', args: '{}' },
          { callId: 's3', name: 'web_search' },
          { callId: 's4', name: 'web_search' },
          { callId: 's5', name: 'web_search' },
        ),
        usage: makeUsage(),
      })
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'e', name: 'end_turn' }), usage: makeUsage() });
    const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});

    await createTestRunner().runStepLoop({
      chatId: 'call-cap',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, search.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    expect(search.execute).toHaveBeenCalledTimes(4);
    expect(send.execute).toHaveBeenCalledOnce();
    const firstResults = persistedResults(onStepComplete, 0);
    expect(firstResults.map(result => result.callId)).toEqual(['s1', 's2', 'm', 's3', 's4', 's5']);
    expect(firstResults.at(-1)?.payload).toContain('budget');
    // Calls exhausted: the next step is the wrap-up.
    expect(schemaNames(1)).toEqual(['send_message', 'react', 'end_turn']);
  });

  it('starts an inherited exhausted chain directly at the wrap-up', async () => {
    const { send, react, endTurn } = participationTools();
    const bash = workTool('bash');
    mockCallLlm.mockResolvedValue({ entries: toolCallEntries({ callId: 'e', name: 'end_turn' }), usage: makeUsage() });

    await createTestRunner().runStepLoop({
      chatId: 'inherited',
      entries: initialEntries,
      system: 'system',
      tools: [send.tool, react.tool, bash.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      budgetUsed: { toolRounds: 2, toolCalls: 2 },
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete: async () => {},
      checkInterrupt: () => false,
      log: logger,
    });

    expect(mockCallLlm).toHaveBeenCalledOnce();
    expect(schemaNames(0)).toEqual(['send_message', 'react', 'end_turn']);
  });

  it('bounds sends and reactions across an inherited chain while still allowing end_turn', async () => {
    const { send, react, endTurn } = participationTools();
    mockCallLlm.mockResolvedValue({
      entries: toolCallEntries(
        { callId: 's1', name: 'send_message' },
        { callId: 'r1', name: 'react' },
        { callId: 's2', name: 'send_message' },
        { callId: 'end', name: 'end_turn' },
      ), usage: makeUsage(),
    });
    const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});
    await createTestRunner().runStepLoop({
      chatId: 'participation-cap', entries: initialEntries, system: 'system',
      tools: [send.tool, react.tool, endTurn.tool], budget: DEFAULT_TURN_BUDGET,
      budgetUsed: { toolRounds: 1, toolCalls: 0, participationCalls: 2 },
      deadlineAtMs: Date.now() + 60_000, onStepComplete,
      checkInterrupt: () => false, log: logger,
    });
    expect(send.execute).toHaveBeenCalledOnce();
    expect(react.execute).not.toHaveBeenCalled();
    expect(endTurn.execute).toHaveBeenCalledOnce();
    expect(persistedResults(onStepComplete, 0)).toHaveLength(4);
    expect(persistedResults(onStepComplete, 0).every(result => !result.requiresFollowUp)).toBe(true);
  });

  describe('deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('caps the model timeout and closes silently when no time is left for another step', async () => {
      const { send, react, endTurn } = participationTools();
      const slow = workTool('bash', vi.fn(() => {
        vi.setSystemTime(Date.now() + 9_000);
        return { content: 'slow', requiresFollowUp: true };
      }));
      mockCallLlm.mockResolvedValue({ entries: toolCallEntries({ callId: 'b', name: 'bash' }), usage: makeUsage() });
      const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});
      const checkInterrupt = vi.fn(() => false);

      await createRunner({
        apiBaseUrl: 'mock',
        apiKey: 'key',
        model: 'mock-model',
        apiFormat: 'openai-chat',
        timeoutSec: 120,
      }).runStepLoop({
        chatId: 'deadline',
        entries: initialEntries,
        system: 'system',
        tools: [send.tool, react.tool, slow.tool, endTurn.tool],
        budget: DEFAULT_TURN_BUDGET,
        deadlineAtMs: Date.now() + 10_000,
        onStepComplete,
        checkInterrupt,
        log: logger,
      });

      expect(mockCallLlm).toHaveBeenCalledOnce();
      expect(mockCallLlm.mock.calls[0]?.[0].timeoutSec).toBeLessThanOrEqual(10);
      expect(slow.execute).toHaveBeenCalledOnce();
      // The executed result is persisted, but the chain does not stay open.
      expect(persistedResults(onStepComplete, 0)).toEqual([
        { kind: 'toolResult', callId: 'b', payload: 'slow', requiresFollowUp: false },
      ]);
      expect(checkInterrupt).not.toHaveBeenCalled();
    });

    it('turns the next step into the wrap-up when the remaining time drops below the reserve', async () => {
      const { send, react, endTurn } = participationTools();
      const slow = workTool('bash', vi.fn(() => {
        vi.setSystemTime(Date.now() + 6_000);
        return { content: 'slow', requiresFollowUp: true };
      }));
      mockCallLlm
        .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'b', name: 'bash' }), usage: makeUsage() })
        .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 's', name: 'send_message', args: '{"text":"hi"}' }), usage: makeUsage() });
      const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});

      await createTestRunner().runStepLoop({
        chatId: 'reserve',
        entries: initialEntries,
        system: 'system',
        tools: [send.tool, react.tool, slow.tool, endTurn.tool],
        budget: { ...DEFAULT_TURN_BUDGET, deadlineMs: 10_000, wrapUpReserveMs: 5_000 },
        deadlineAtMs: Date.now() + 10_000,
        onStepComplete,
        checkInterrupt: () => false,
        log: logger,
      });

      // 4 s left: below the 5 s reserve but enough for a model call.
      expect(mockCallLlm).toHaveBeenCalledTimes(2);
      expect(schemaNames(0)).toEqual(['send_message', 'react', 'bash', 'end_turn']);
      expect(schemaNames(1)).toEqual(['send_message', 'react', 'end_turn']);
      expect(send.execute).toHaveBeenCalledOnce();
      expect(persistedResults(onStepComplete, 1).every(result => !result.requiresFollowUp)).toBe(true);
    });

    it('skips later side effects in the same batch after a running tool exceeds the deadline', async () => {
      const { send, react, endTurn } = participationTools();
      const slow = workTool('bash', vi.fn(() => {
        vi.setSystemTime(Date.now() + 20_000);
        return { content: 'finished', requiresFollowUp: true };
      }));
      const second = workTool('web_search');
      mockCallLlm.mockResolvedValue({
        entries: toolCallEntries(
          { callId: 'a', name: 'bash' },
          { callId: 'b', name: 'web_search' },
          { callId: 's', name: 'send_message' },
        ), usage: makeUsage(),
      });
      const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});
      await createTestRunner().runStepLoop({
        chatId: 'expired-batch', entries: initialEntries, system: 'system',
        tools: [slow.tool, second.tool, send.tool, react.tool, endTurn.tool],
        budget: DEFAULT_TURN_BUDGET, deadlineAtMs: Date.now() + 10_000,
        onStepComplete, checkInterrupt: () => false, log: logger,
      });
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(second.execute).not.toHaveBeenCalled();
      expect(send.execute).not.toHaveBeenCalled();
      expect(persistedResults(onStepComplete, 0)).toHaveLength(3);
      expect(persistedResults(onStepComplete, 0).every(result => !result.requiresFollowUp)).toBe(true);
    });

    const failingStep = (timeoutSec: number | undefined, deadlineMs: number) => {
      const { send, react, endTurn } = participationTools();
      mockCallLlm.mockImplementation(async config => {
        throw new Error(`chat request timed out after ${config.timeoutSec}s`);
      });
      return createRunner({
        apiBaseUrl: 'mock', apiKey: 'key', model: 'mock-model', apiFormat: 'openai-chat', timeoutSec,
      }).runStepLoop({
        chatId: 'timeout-kind', entries: initialEntries, system: 'system',
        tools: [send.tool, react.tool, endTurn.tool],
        budget: DEFAULT_TURN_BUDGET, deadlineAtMs: Date.now() + deadlineMs,
        onStepComplete: async () => {}, checkInterrupt: () => false, log: logger,
      });
    };

    it.each([
      ['the endpoint timeout exceeds the remaining deadline', 120],
      ['the endpoint has no timeout', undefined],
    ])('reports a deadline-capped model timeout as permanent deadline expiry when %s', async (_name, timeoutSec) => {
      const error = await failingStep(timeoutSec, 10_000).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Turn deadline reached during model step 1');
      expect(((error as Error).cause as Error).message).toMatch(/request timed out after/);
      expect(isTransientModelError(error)).toBe(false);
    });

    it('keeps a provider timeout shorter than the remaining deadline transient', async () => {
      const error = await failingStep(5, 10_000).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe('chat request timed out after 5s');
      expect(isTransientModelError(error)).toBe(true);
    });

    it('does not start a model call once the deadline has passed', async () => {
      const onStepComplete = vi.fn(async () => {});

      await expect(createTestRunner().runStepLoop({
        chatId: 'expired',
        entries: initialEntries,
        system: 'system',
        tools: [],
        budget: DEFAULT_TURN_BUDGET,
        deadlineAtMs: Date.now() + 1_000,
        onStepComplete,
        checkInterrupt: () => false,
        log: logger,
      })).rejects.toThrow('Turn deadline reached');

      expect(mockCallLlm).not.toHaveBeenCalled();
      expect(onStepComplete).not.toHaveBeenCalled();
    });
  });

  it('keeps earlier persisted steps when a later model call fails', async () => {
    const bash = workTool('bash');
    mockCallLlm
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'b', name: 'bash' }), usage: makeUsage() })
      .mockRejectedValueOnce(new Error('provider down'));
    const order: string[] = [];
    const onStepComplete = vi.fn(async () => { order.push('persist'); });

    await expect(createTestRunner().runStepLoop({
      chatId: 'model-error',
      entries: initialEntries,
      system: 'system',
      tools: [bash.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt: () => { order.push('interrupt'); return false; },
      log: logger,
    })).rejects.toThrow('provider down');

    expect(order).toEqual(['persist', 'interrupt']);
    expect(bash.execute).toHaveBeenCalledOnce();
  });

  it('persists a failing tool as an error result before the next step', async () => {
    const failing = workTool('bash', vi.fn(() => { throw new Error('boom'); }));
    const { endTurn } = participationTools();
    mockCallLlm
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'b', name: 'bash' }), usage: makeUsage() })
      .mockResolvedValueOnce({ entries: toolCallEntries({ callId: 'e', name: 'end_turn' }), usage: makeUsage() });
    const onStepComplete = vi.fn(async (_entries: ConversationEntry[]) => {});

    await createTestRunner().runStepLoop({
      chatId: 'tool-error',
      entries: initialEntries,
      system: 'system',
      tools: [failing.tool, endTurn.tool],
      budget: DEFAULT_TURN_BUDGET,
      deadlineAtMs: Date.now() + 60_000,
      onStepComplete,
      checkInterrupt: () => false,
      log: logger,
    });

    const [result] = persistedResults(onStepComplete, 0);
    expect(result).toMatchObject({ callId: 'b', requiresFollowUp: true });
    expect(result?.payload).toContain('boom');
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
  });
});

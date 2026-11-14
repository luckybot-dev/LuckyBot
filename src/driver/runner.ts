import type { Logger } from '@guiiai/logg';

import type { CahciuaTool } from './tools';
import { executeToolCall, extractToolCalls, toToolSchema } from './tools';
import { PARTICIPATION_TOOL_NAMES, runTurnLoop, type ExecutedStepResult, type ModelStepOptions, type ModelStepResult } from './turn-loop';
import type { TurnBudget, TurnBudgetUsage } from './types';
import { callLlm, type ForceToolChoice, type LlmCallConfig, type LlmCallUsage } from '../llm/call';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

export interface RunnerConfig extends Omit<LlmCallConfig, 'forceToolChoice'> {}

interface CallModelStepParams {
  chatId: string;
  entries: ConversationEntry[];
  system: string;
  tools: CahciuaTool[];
  step: number;
  maxImagesAllowed?: number;
  // The tool call this step must contain. A response without it is discarded
  // and the model is called again, whether or not the request could force it.
  forceToolChoice?: ForceToolChoice;
  // `false` keeps that requirement but leaves `tool_choice` out of the request,
  // for an endpoint configured with `forceToolChoice: false`.
  sendToolChoice?: boolean;
  options: ModelStepOptions;
  log: Logger;
}

interface ExecuteToolStepParams {
  modelStep: ModelStepResult;
  tools: CahciuaTool[];
  remainingToolCalls: number;
  remainingParticipationCalls: number;
  deadlineAtMs: number;
  log: Logger;
}

export interface StepLoopParams extends Omit<CallModelStepParams, 'entries' | 'step' | 'options'> {
  entries: ConversationEntry[];
  budget: TurnBudget;
  budgetUsed?: TurnBudgetUsage;
  // A react_only turn closes after this step even if a tool result asks for
  // follow-up (see TurnLoopParams).
  reactOnly?: boolean;
  deadlineAtMs: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: LlmCallUsage,
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
}

const MAX_FORCE_TOOL_RETRIES = 3;

const budgetSkipped = (callId: string): ToolResult => ({
  kind: 'toolResult',
  callId,
  payload: JSON.stringify({ error: 'Tool budget for this turn is exhausted; this call was not executed.' }),
  requiresFollowUp: true,
});

const assistantTextLength = (entries: ConversationEntry[]): number => {
  let length = 0;
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    for (const part of entry.parts)
      if (part.kind === 'text') length += part.text.trim().length;
  }
  return length;
};

const addUsage = (left: LlmCallUsage, right: LlmCallUsage): LlmCallUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
});

export const createRunner = (config: RunnerConfig) => {
  const callModelStep = async (params: CallModelStepParams): Promise<ModelStepResult> => {
    const stepRequestedAt = Date.now();
    const tools = params.options.wrapUp
      ? params.tools.filter(tool => PARTICIPATION_TOOL_NAMES.has(tool.name))
      : params.tools;
    const toolSchemas = tools.map(toToolSchema);

    // Model calls have no side effects, so aborting them at the deadline is
    // safe. Each attempt, including forced-choice retries, gets the remainder.
    const invokeModel = () => {
      const remainingSec = (params.options.deadlineAtMs - Date.now()) / 1000;
      if (remainingSec <= 0)
        throw new Error(`Turn deadline reached before model step ${params.step}`);
      // Transports treat a falsy timeoutSec as "no timeout".
      const cappedByDeadline = !config.timeoutSec || remainingSec < config.timeoutSec;
      const timeoutSec = cappedByDeadline ? remainingSec : config.timeoutSec!;
      return callLlm(
        {
          ...config,
          timeoutSec,
          forceToolChoice: params.sendToolChoice === false ? undefined : params.forceToolChoice,
        },
        params.entries,
        params.system,
        toolSchemas,
        {
          log: params.log,
          label: `step:${params.step}`,
          dumpId: params.chatId,
          maxImagesAllowed: params.maxImagesAllowed,
        },
      ).catch((error: unknown) => {
        // A timeout we shortened to the remaining deadline is deadline expiry,
        // not a provider failure, so the scheduler must not retry it. A
        // provider timeout below the remaining deadline stays as thrown.
        if (cappedByDeadline && error instanceof Error && error.message.includes('request timed out after'))
          throw new Error(`Turn deadline reached during model step ${params.step}`, { cause: error });
        throw error;
      });
    };

    let result = await invokeModel();
    let usage = { ...result.usage };

    if (params.forceToolChoice) {
      const choice = params.forceToolChoice;
      // A provider may ignore tool_choice, reject it (callLlm then calls
      // without it) or never be sent it. A reply written as plain text is not a
      // message: only tool calls act, so such a step would end the turn with
      // the text discarded (issue #37). Rejected responses contribute usage,
      // but only the selected/final response can reach tool execution.
      const requirementMet = () => {
        const toolCalls = extractToolCalls(result.entries);
        return choice === 'any'
          ? toolCalls.length > 0
          : toolCalls.some(toolCall => toolCall.name === choice.name);
      };

      for (let retry = 1; retry <= MAX_FORCE_TOOL_RETRIES && !requirementMet(); retry++) {
        params.log.withFields({
          chatId: params.chatId,
          step: params.step,
          attempt: retry,
          maxRetries: MAX_FORCE_TOOL_RETRIES,
          forceToolChoice: choice,
          toolChoiceSent: params.sendToolChoice !== false,
          textChars: assistantTextLength(result.entries),
        }).warn('Model step lacks the required tool call; retrying');

        result = await invokeModel();
        usage = addUsage(usage, result.usage);
      }
      if (!requirementMet())
        throw new Error(`Model did not satisfy forced tool choice after ${MAX_FORCE_TOOL_RETRIES + 1} attempts`);
    }

    // end_turn closes the turn, so text written beside it and no send_message
    // reaches nobody. Seen once in 183 unforced primary steps (2026-11-14) and
    // not retried: the model did choose to end. Logged so a rise is visible.
    const calledNames = new Set(extractToolCalls(result.entries).map(toolCall => toolCall.name));
    if (calledNames.has('end_turn') && !calledNames.has('send_message')
      && tools.some(tool => tool.name === 'send_message')) {
      const textChars = assistantTextLength(result.entries);
      if (textChars > 0)
        params.log.withFields({ chatId: params.chatId, step: params.step, textChars })
          .warn('Model wrote text beside end_turn without send_message; the text is not sent');
    }

    return {
      modelEntries: result.entries,
      usage,
      requestedAtMs: stepRequestedAt,
    };
  };

  const executeToolStep = async (params: ExecuteToolStepParams): Promise<ExecutedStepResult> => {
    const toolCalls = extractToolCalls(params.modelStep.modelEntries);
    const toolResults: ToolResult[] = [];
    let remainingToolCalls = params.remainingToolCalls;
    let remainingParticipationCalls = params.remainingParticipationCalls;
    for (const toolCall of toolCalls) {
      // Do not start another side effect after expiry. Already-running calls
      // finish and all results are persisted together; end_turn is harmless.
      const participating = toolCall.name === 'send_message' || toolCall.name === 'react';
      if (toolCall.name !== 'end_turn' && (Date.now() >= params.deadlineAtMs || (participating && remainingParticipationCalls <= 0))) {
        toolResults.push(budgetSkipped(toolCall.callId));
        continue;
      }
      if (participating) remainingParticipationCalls--;
      // Every call needs a result for the provider; over-budget work calls get
      // an explicit not-executed result instead of running.
      if (!PARTICIPATION_TOOL_NAMES.has(toolCall.name)) {
        if (remainingToolCalls <= 0) {
          params.log.withFields({ tool: toolCall.name }).log('Tool budget exhausted; skipping call');
          toolResults.push(budgetSkipped(toolCall.callId));
          continue;
        }
        remainingToolCalls--;
      }
      toolResults.push(await executeToolCall(
        toolCall.callId,
        toolCall.name,
        toolCall.args,
        params.tools,
        params.log,
      ));
    }

    return {
      stepEntries: [...params.modelStep.modelEntries, ...toolResults],
      usage: params.modelStep.usage,
      requestedAtMs: params.modelStep.requestedAtMs,
      hasToolCalls: toolCalls.length > 0,
    };
  };

  const runStepLoop = (params: StepLoopParams): Promise<void> => runTurnLoop(
    params,
    {
      callModelStep: (entries, step, options) => callModelStep({
        chatId: params.chatId,
        entries,
        system: params.system,
        tools: params.tools,
        step,
        options,
        maxImagesAllowed: params.maxImagesAllowed,
        forceToolChoice: params.forceToolChoice,
        sendToolChoice: params.sendToolChoice,
        log: params.log,
      }),
      executeToolStep: (modelStep, options) => executeToolStep({
        modelStep,
        tools: params.tools,
        remainingToolCalls: options.remainingToolCalls,
        remainingParticipationCalls: options.remainingParticipationCalls,
        deadlineAtMs: options.deadlineAtMs,
        log: params.log,
      }),
    },
  );

  return { runStepLoop };
};

import type { Logger } from '@guiiai/logg';

import { resolveBashGate, SHELL_TOOL_NAMES } from './bash-gate';
import { composeContext, composeProbeContext, injectLateBindingPrompt, lastActedAtMs, latestExternalEventMs, wasToolLoopInterrupted } from './context';
import type { ProbeWindowState } from './context';
import { evaluateParticipationLimit } from './participation-limit';
import { computeParticipationStats } from './participation-stats';
import type { DriverPlatform } from './platform';
import { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
import type { createRunner } from './runner';
import { createDecideTool, extractDecideResult, toToolSchema } from './tools';
import type { CahciuaTool } from './tools';
import { countParticipationCalls, countWorkToolCalls, DEFAULT_TURN_BUDGET, REACT_ONLY_TOOL_NAMES } from './turn-loop';
import type { ProbeActivation, ProbeResponseV2, ResolvedChatConfig, TurnBudget, TurnBudgetUsage, TurnResponseV2 } from './types';
import type { WakeupStage } from './wakeup-health';
import type { ActiveTaskInfo } from '../background-task/types';
import { callLlm } from '../llm/call';
import type { MemorySnapshot } from '../memory/injection';
import type { RenderedContext } from '../rendering/types';

export const localTimeNow = (): string => {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0');
  const timezone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${timezone}`;
};

const hasFollowUp = (tr: TurnResponseV2): boolean =>
  tr.entries.some(entry => entry.kind === 'toolResult' && entry.requiresFollowUp);

// Budget already spent by the open interruption chain: the latest TR plus each
// earlier TR whose follow-up continued into it. Derived from persisted TRs, so
// continuations (including after restart) cannot reset the counts.
export const interruptedChainUsage = (trs: TurnResponseV2[]): TurnBudgetUsage => {
  const used: TurnBudgetUsage = { toolRounds: 0, toolCalls: 0 };
  for (let i = trs.length - 1; i >= 0; i--) {
    used.toolRounds++;
    used.toolCalls += countWorkToolCalls(trs[i]!.entries);
    used.participationCalls = (used.participationCalls ?? 0) + countParticipationCalls(trs[i]!.entries);
    if (i === 0 || !hasFollowUp(trs[i - 1]!)) break;
  }
  return used;
};

export const executeWakeup = async (params: {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  // Platform name rendered into prompts; selects platform-specific formatting.
  currentChannel: DriverPlatform['name'];
  contextAtStart: RenderedContext;
  currentContext: () => RenderedContext;
  cursorMs?: number;
  summary?: string;
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, response: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, response: ProbeResponseV2) => Promise<void>;
  getChatTitle: (chatId: string) => string | undefined;
  getActiveBackgroundTasks: (chatId: string) => ActiveTaskInfo[];
  sendTypingAction: (chatId: string) => Promise<void>;
  createTools: () => CahciuaTool[];
  runner: Pick<ReturnType<typeof createRunner>, 'runStepLoop'>;
  getLastProcessedMs: () => number;
  setLastProcessedMs: (value: number) => void;
  turnBudget?: TurnBudget;
  // Trusted-maintainer predicate from deployment config; the bash gate decides
  // tool exposure from canonical sender ids only.
  isMaintainer: (userId: string) => boolean;
  // Per-chat probe window start, carried across wake-ups so the probe prefix
  // stays stable between hysteresis jumps. Mutated in place by the probe call.
  probeWindow?: ProbeWindowState;
  // Person memory. The snapshot is read once, before the probe, and rendered
  // into both late-binding prompts, so a write mid-turn cannot split the probe's
  // view from primary's. Absent or null leaves every prompt untouched.
  memoryEnabled?: boolean;
  loadMemorySnapshot?: (context: RenderedContext) => MemorySnapshot | null;
  // Gated extension hints contributed by enabled plugins for this chat.
  promptHints?: string[];
  // Extra late-binding hint contributed by an active scene or scene profile.
  sceneHint?: string;
  // Private notes contributed by active scenes (primary late-binding only).
  sceneNotes?: string;
  // Set when retrying this context after primary failed transiently: probe
  // already activated it, so judging again would only add latency.
  probeActivation?: ProbeActivation;
  onProbeActivated?: (activation: ProbeActivation) => void;
  // Failure attribution: called with `probe` just before the probe request and
  // `primary` once the probe gate is passed (or skipped for a continuation).
  onStage?: (stage: WakeupStage) => void;
  // Probe request finished with a decision; `malformed` means none was usable.
  onProbeComplete?: (result: { elapsedMs: number; malformed: boolean }) => void;
  log: Logger;
}): Promise<void> => {
  const budget = params.turnBudget ?? DEFAULT_TURN_BUDGET;
  const turnResponses = await params.loadTurnResponses(params.chatId, params.cursorMs);
  const primaryContext = composeContext(
    params.contextAtStart,
    turnResponses,
    params.chatConfig.compaction.maxContextEstTokens,
    params.chatConfig.primary.model.model,
    params.summary,
    params.chatConfig.primary.reasoningReplayTurns,
  );
  if (!primaryContext) {
    if (wasToolLoopInterrupted(turnResponses)) throw new Error('Cannot compose context for an open tool continuation');
    return;
  }

  params.log.withFields({
    chatId: params.chatId,
    entries: primaryContext.entries.length,
    estimatedTokens: primaryContext.estimatedTokens,
  }).log('Triggering LLM call');

  const interrupted = wasToolLoopInterrupted(turnResponses);
  const bashGate = resolveBashGate({
    rc: params.contextAtStart,
    turnResponses,
    interrupted,
    isMaintainer: params.isMaintainer,
    requireMaintainer: params.chatConfig.tools.bash.requireMaintainer,
    nowMs: Date.now(),
    maintainerWindowMs: params.chatConfig.tools.bash.maintainerWindowSec * 1000,
  });
  if (bashGate.reason === 'maintainer')
    params.log.withFields({ chatId: params.chatId, maintainerId: bashGate.maintainerId }).log('Bash tool gate open');
  else if (bashGate.reason === 'persisted')
    params.log.withFields({ chatId: params.chatId }).log('Bash tool gate open (chain decision reused)');
  else if (bashGate.reason === 'maintainer-required-off')
    params.log.withFields({ chatId: params.chatId }).debug('Bash tool gate open (requireMaintainer disabled)');
  else if (params.chatConfig.tools.bash.enabled)
    // Info only where the shell tools would otherwise have been exposed; a
    // chat that disabled bash should not log this every wake-up.
    params.log.withFields({ chatId: params.chatId, interrupted, reason: bashGate.reason }).log('Bash tool gate closed');
  else
    params.log.withFields({ chatId: params.chatId, interrupted, reason: bashGate.reason }).debug('Bash tool gate closed (bash disabled)');
  const shellMaintainerGated = params.chatConfig.tools.bash.enabled && params.chatConfig.tools.bash.requireMaintainer;
  const participation = params.chatConfig.participation;
  const backgroundTasks = params.getActiveBackgroundTasks(params.chatId);
  const timeNow = localTimeNow();
  // Derived from the unfiltered context: `isMyself` segments are the bot's own
  // messages here even when the prompt pipeline trims ones covered by tool
  // calls. Shared by the probe and primary late-binding prompts.
  const participationStats = computeParticipationStats({ segments: params.contextAtStart, nowMs: Date.now() });
  const memorySnapshot = params.loadMemorySnapshot?.(params.contextAtStart) ?? null;
  const memoryEnabled = params.memoryEnabled === true;
  let probeReason: string | undefined;
  let reactOnly = params.probeActivation?.reactOnly ?? false;

  if (!interrupted && params.probeActivation) {
    params.log.withFields({ chatId: params.chatId, reason: params.probeActivation.reason })
      .log('Reusing probe activation from the failed attempt');
    probeReason = params.probeActivation.reason;
  } else if (!interrupted) {
    params.log.withFields({
      chatId: params.chatId,
      lastProcessedMs: params.getLastProcessedMs(),
    }).log('Running probe');
    // Mandatory probe region: everything since the bot's last real action, not
    // since the last processed watermark. A no_action or fail-closed probe
    // advances the watermark, and starting there could hide an earlier
    // unanswered address or a late-delivered event from every later probe.
    const lastActedMs = lastActedAtMs(params.contextAtStart, turnResponses);
    const limit = evaluateParticipationLimit({
      segments: params.contextAtStart,
      lastActedMs,
      nowMs: Date.now(),
      config: participation,
    });
    // Limited and nothing deterministic addresses the bot: the probe may still
    // wake it for a name-call, but not to chime in or react on its own.
    const addressOnly = limit.limited && !limit.bypassed;
    if (addressOnly)
      params.log.withFields({ chatId: params.chatId, reason: limit.reason })
        .log('Participation limit reached: only a direct address may wake the bot');
    const probeContext = composeProbeContext(
      params.contextAtStart,
      turnResponses,
      params.chatConfig.probe.contextEstTokens,
      params.summary,
      {
        lastActedMs,
        previousStartMs: params.probeWindow?.startMs ?? null,
        summaryMaxEstTokens: params.chatConfig.probe.summaryMaxEstTokens,
      },
    );
    if (!probeContext) return;
    if (params.probeWindow) params.probeWindow.startMs = probeContext.windowStartMs;
    if (probeContext.overCap)
      params.log.withFields({
        chatId: params.chatId,
        lastActedMs,
        omittedMessages: probeContext.omittedCount,
        omittedEstTokens: probeContext.omittedEstTokens,
      }).warn('Probe window over budget: oldest unprocessed context omitted');

    const system = await renderSystemPrompt({
      mode: 'probe',
      currentChannel: params.currentChannel,
      chatId: params.chatId,
      chatTitle: params.getChatTitle(params.chatId),
      systemFiles: params.chatConfig.systemFiles,
      shellMaintainerGated,
      participationStyle: participation.style,
      botInteraction: participation.botInteraction,
      brakeMessages10m: participation.brakeMessages10m,
      botRounds: participation.botRounds,
    });
    const entries = [...probeContext.entries];
    injectLateBindingPrompt(entries, await renderLateBindingPrompt({
      mode: 'probe',
      currentChannel: params.currentChannel,
      timeNow,
      activeBackgroundTasks: backgroundTasks,
      ...participationStats,
      ...(addressOnly ? { participationLimited: true } : {}),
      ...(memorySnapshot?.probeXml ? { memoryXml: memorySnapshot.probeXml } : {}),
    }));

    const decideTool = createDecideTool();
    const requestedAtMs = Date.now();
    params.onStage?.('probe');
    const probeModel = params.chatConfig.probe.model;
    const probeTimeoutSec = params.chatConfig.probe.timeoutMs / 1000;
    const result = await callLlm(
      {
        ...probeModel,
        timeoutSec: probeModel.timeoutSec ? Math.min(probeModel.timeoutSec, probeTimeoutSec) : probeTimeoutSec,
        // Thinking-mode providers reject a forced tool_choice; they still call
        // `decide` on their own when the choice is left free.
        forceToolChoice: probeModel.forceToolChoice === false ? undefined : { name: 'decide' },
      },
      entries,
      system,
      [decideTool].map(toToolSchema),
      {
        log: params.log,
        label: `probe:${params.chatId}`,
        dumpId: `${params.chatId}.probe`,
        maxImagesAllowed: params.chatConfig.probe.model.maxImagesAllowed,
      },
    );
    const decision = extractDecideResult(result.entries);
    params.onProbeComplete?.({ elapsedMs: Date.now() - requestedAtMs, malformed: decision == null });
    if (decision == null)
      // Fails closed to no_action below; named here so it is not mistaken for a
      // deliberate silence.
      params.log.withFields({ chatId: params.chatId, elapsedMs: Date.now() - requestedAtMs })
        .warn('Probe returned no usable decision; failing closed to no_action');
    // Missing or malformed decisions fail closed. `react_only` still activates
    // primary, but with a restricted tool set so it cannot send a message.
    // A reaction is never an answer to a direct address, so under a reached
    // limit it is refused outright.
    const limitedReaction = addressOnly && decision?.should_act === 'react_only';
    const activated = decision != null && decision.should_act !== 'no_action' && !limitedReaction;
    reactOnly = !limitedReaction && decision?.should_act === 'react_only';
    params.log.withFields({
      chatId: params.chatId,
      shouldAct: activated,
      action: decision?.should_act,
      reason: decision?.reason,
      ...(limitedReaction ? { refusedByParticipationLimit: true } : {}),
    }).log('Probe result');
    await params.persistProbeResponse(params.chatId, {
      requestedAtMs,
      entries: result.entries,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      modelName: params.chatConfig.probe.model.model,
      isActivated: activated,
      createdAt: Date.now(),
    });
    params.setLastProcessedMs(requestedAtMs);
    if (!activated) return;
    probeReason = decision.reason;
    params.onProbeActivated?.({ reason: decision.reason, ...(reactOnly ? { reactOnly: true } : {}) });
  }

  params.onStage?.('primary');
  // The primary deadline starts here, so a slow probe cannot eat into it.
  const deadlineAtMs = Date.now() + budget.deadlineMs;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  const sendTyping = (): void => {
    void params.sendTypingAction(params.chatId).catch(error =>
      params.log.withError(error).withFields({ chatId: params.chatId }).debug('Typing action failed'));
  };
  if (params.chatConfig.sendTypingAction) {
    sendTyping();
    typingInterval = setInterval(() => {
      sendTyping();
    }, 5000);
  }

  try {
    const system = await renderSystemPrompt({
      mode: 'primary',
      currentChannel: params.currentChannel,
      chatId: params.chatId,
      chatTitle: params.getChatTitle(params.chatId),
      systemFiles: params.chatConfig.systemFiles,
      shellMaintainerGated,
      participationStyle: participation.style,
      botInteraction: participation.botInteraction,
      brakeMessages10m: participation.brakeMessages10m,
      botRounds: participation.botRounds,
      ...(memoryEnabled ? { memoryEnabled: true } : {}),
      ...(params.promptHints && params.promptHints.length > 0 ? { promptHints: params.promptHints } : {}),
    });
    injectLateBindingPrompt(primaryContext.entries, await renderLateBindingPrompt({
      mode: 'primary',
      currentChannel: params.currentChannel,
      timeNow,
      isInterrupted: interrupted,
      activeBackgroundTasks: backgroundTasks,
      ...(probeReason ? { probeReason } : {}),
      ...(reactOnly ? { reactOnly: true } : {}),
      ...participationStats,
      brakeMessages10m: participation.brakeMessages10m,
      botRounds: participation.botRounds,
      ...(params.sceneHint ? { sceneHint: params.sceneHint } : {}),
      ...(params.sceneNotes ? { sceneNotes: params.sceneNotes } : {}),
      ...(memorySnapshot?.primaryXml ? { memoryXml: memorySnapshot.primaryXml } : {}),
    }));
    const tools = (reactOnly
      ? params.createTools().filter(tool => REACT_ONLY_TOOL_NAMES.has(tool.name))
      : params.createTools())
      // The gate is decided once per wake-up; the same tool set serves every
      // step of the turn, so a maintainer message arriving mid-chain cannot
      // open it and a closed gate cannot leak into a later turn.
      .filter(tool => bashGate.open || !SHELL_TOOL_NAMES.has(tool.name));

    const persistStep = async (
      entries: TurnResponseV2['entries'],
      usage: Pick<TurnResponseV2, 'cacheReadTokens' | 'cacheWriteTokens' | 'inputTokens' | 'outputTokens'>,
      requestedAtMs: number,
    ): Promise<void> => {
      await params.persistTurnResponse(params.chatId, {
        requestedAtMs,
        entries,
        shellToolsExposed: bashGate.open,
        ...usage,
        modelName: params.chatConfig.primary.model.model,
      });
      params.setLastProcessedMs(requestedAtMs);
    };

    await params.runner.runStepLoop({
      chatId: params.chatId,
      entries: primaryContext.entries,
      system,
      tools,
      budget,
      ...(interrupted ? { budgetUsed: interruptedChainUsage(turnResponses) } : {}),
      // react_only turns never leave an open chain: the loop closes after the
      // first step even though `react` reports follow-up.
      ...(reactOnly ? { reactOnly: true } : {}),
      deadlineAtMs,
      maxImagesAllowed: params.chatConfig.primary.model.maxImagesAllowed,
      // `end_turn` is a tool, so forcing a tool call still permits silence.
      // Omitted for providers that reject a forced tool_choice.
      ...(params.chatConfig.primary.model.forceToolChoice === false ? {} : { forceToolChoice: 'any' as const }),
      onStepComplete: persistStep,
      checkInterrupt: () =>
        params.currentContext() !== params.contextAtStart
        && latestExternalEventMs(params.currentContext(), params.getLastProcessedMs()) != null,
      log: params.log,
    });
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
};

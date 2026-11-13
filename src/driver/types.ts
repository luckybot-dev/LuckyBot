import type { ResolvedChatConfig, WatchdogConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry } from '../unified-api/types';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  // Bash gate decision of the turn that wrote this step. Persisted on every
  // step; an interrupted continuation reuses it instead of recomputing.
  shellToolsExposed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
}

export interface ProbeResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
  isActivated: boolean;
  createdAt: number;
}

export interface DriverConfig {
  chatIds: string[];
  resolveChatConfig: (chatId: string) => ResolvedChatConfig;
  // Trusted-maintainer predicate from deployment config (TOKENS.IS_MAINTAINER).
  // Absent means no maintainers: chats with tools.bash.requireMaintainer stay
  // gated closed.
  isMaintainer?: (userId: string) => boolean;
  // Absent means no watchdog (tests, embedders); the container passes the
  // validated `watchdog` config block.
  watchdog?: WatchdogConfig;
}

export interface CompactionConfig {
  maxContextEstTokens: number;
  workingWindowEstTokens: number;
  model?: LlmEndpoint;
}

export interface DebounceConfig {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
}

// Primary tool-loop budget. Counts accumulate across an interruption chain
// (TRs joined by requiresFollowUp); the deadline is per primary execution.
export interface TurnBudget {
  // Regular model steps (all tools visible) before the tool-less wrap-up.
  maxToolRounds: number;
  // Work-tool calls; participation tools (send_message/react/end_turn) are exempt.
  maxToolCalls: number;
  // Combined send_message/react attempts across the chain; end_turn is exempt.
  maxParticipationCalls?: number;
  // Measured from the start of primary in this wake-up; probe time is bounded
  // separately by the chat's probe.timeoutMs and never consumes it.
  deadlineMs: number;
  // A model call starts only with at least this much deadline left; its HTTP
  // timeout is the remaining time, capped by the endpoint's timeoutSec.
  minModelCallMs: number;
  // With less than this much deadline left, the next step is the
  // participation-only wrap-up, so a turn that spent its time on tools still
  // gets one chance to answer instead of closing silently at the deadline.
  wrapUpReserveMs?: number;
}

// A probe that activated primary for a context whose primary then failed
// transiently; a retry of that same context reuses it instead of re-judging.
// `reactOnly` wakes primary with only the `react` and `end_turn` tools exposed.
export interface ProbeActivation {
  reason: string;
  reactOnly?: boolean;
}

export interface TurnBudgetUsage {
  toolRounds: number;
  toolCalls: number;
  participationCalls?: number;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type { ResolvedChatConfig } from '../config/config';

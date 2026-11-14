import type { LlmEndpoint } from './types';

// Whether an endpoint accepts a forced `tool_choice` is a property of the model
// variant that answers, not of the configured model name. DeepSeek's thinking
// mode rejects `required` and named choices with
// `400 Thinking mode does not support this tool_choice`; Command Code's
// `deepseek-v4.1-flash` did so on 2026-10-16 and, served by its `-dedicated`
// variant, accepted and honoured both with thinking on by 2026-11-14 (issue
// #37). A static config flag cannot follow that, so a rejection is detected
// from the response and remembered here for a while: later calls to the same
// endpoint skip the choice instead of paying a failed request each time, and
// the next attempt after the latch expires notices when forcing works again.

export const TOOL_CHOICE_REJECTION_TTL_MS = 10 * 60_000;

// Transports throw `<format> API <status>: <body>` (src/llm/{chat,messages,
// responses}.ts). A rejected parameter is a 400 or 422 whose body names it.
const REJECTION_STATUS = /\bAPI (?:400|422):/;
const NAMES_TOOL_CHOICE = /tool[_ ]choice/i;

export const isToolChoiceRejection = (error: unknown): boolean =>
  error instanceof Error && REJECTION_STATUS.test(error.message) && NAMES_TOOL_CHOICE.test(error.message);

const rejectedUntilMs = new Map<string, number>();

export const toolChoiceEndpointKey = (endpoint: Pick<LlmEndpoint, 'apiFormat' | 'apiBaseUrl' | 'model'>): string =>
  `${endpoint.apiFormat}\n${endpoint.apiBaseUrl}\n${endpoint.model}`;

export const isToolChoiceLatchedOff = (key: string, nowMs: number): boolean => {
  const until = rejectedUntilMs.get(key);
  if (until === undefined) return false;
  if (nowMs < until) return true;
  rejectedUntilMs.delete(key);
  return false;
};

export const latchToolChoiceOff = (key: string, nowMs: number): void => {
  rejectedUntilMs.set(key, nowMs + TOOL_CHOICE_REJECTION_TTL_MS);
};

export const resetToolChoiceLatches = (): void => {
  rejectedUntilMs.clear();
};

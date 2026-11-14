export type ProviderFormat = 'openai-chat' | 'responses' | 'anthropic-messages';

export interface LlmEndpoint {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: ProviderFormat;
  maxImagesAllowed?: number;
  timeoutSec?: number;
  /**
   * `false` never sends a forced `tool_choice`. Left on (the default), an
   * endpoint that rejects it (`Thinking mode does not support this
   * tool_choice`) is detected and called without it (src/llm/tool-choice.ts),
   * so `false` is only for a provider whose rejection is not recognised. The
   * driver requires its tool call either way.
   */
  forceToolChoice?: boolean;
  extraBody?: Record<string, unknown>;
}

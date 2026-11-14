import { beforeEach, describe, expect, it } from 'vitest';

import {
  isToolChoiceLatchedOff,
  isToolChoiceRejection,
  latchToolChoiceOff,
  resetToolChoiceLatches,
  TOOL_CHOICE_REJECTION_TTL_MS,
  toolChoiceEndpointKey,
} from './tool-choice';

describe('isToolChoiceRejection', () => {
  it('recognises a 400 or 422 whose body names tool_choice', () => {
    expect(isToolChoiceRejection(new Error(
      'Chat Completions API 400: {"error":{"message":"Thinking mode does not support this tool_choice"}}',
    ))).toBe(true);
    expect(isToolChoiceRejection(new Error('Messages API 400: tool choice `any` is not supported with thinking'))).toBe(true);
    expect(isToolChoiceRejection(new Error('Responses API 422: invalid tool_choice'))).toBe(true);
  });

  it('leaves every other failure alone', () => {
    expect(isToolChoiceRejection(new Error('Chat Completions API 400: context length exceeded'))).toBe(false);
    expect(isToolChoiceRejection(new Error('Chat Completions API 500: tool_choice handler crashed'))).toBe(false);
    expect(isToolChoiceRejection(new Error('Chat Completions API 429: rate limited'))).toBe(false);
    expect(isToolChoiceRejection(new Error('Chat Completions request timed out after 15s'))).toBe(false);
    expect(isToolChoiceRejection('Chat Completions API 400: tool_choice')).toBe(false);
  });
});

describe('tool_choice latch', () => {
  beforeEach(() => {
    resetToolChoiceLatches();
  });

  it('holds for the TTL and then lets the endpoint be forced again', () => {
    const key = toolChoiceEndpointKey({ apiFormat: 'openai-chat', apiBaseUrl: 'http://a/v1', model: 'm' });
    expect(isToolChoiceLatchedOff(key, 1_000)).toBe(false);
    latchToolChoiceOff(key, 1_000);
    expect(isToolChoiceLatchedOff(key, 1_000 + TOOL_CHOICE_REJECTION_TTL_MS - 1)).toBe(true);
    expect(isToolChoiceLatchedOff(key, 1_000 + TOOL_CHOICE_REJECTION_TTL_MS)).toBe(false);
  });

  it('is per endpoint: base URL, model and format all distinguish', () => {
    const base = { apiFormat: 'openai-chat' as const, apiBaseUrl: 'http://a/v1', model: 'm' };
    latchToolChoiceOff(toolChoiceEndpointKey(base), 0);
    expect(isToolChoiceLatchedOff(toolChoiceEndpointKey({ ...base, model: 'other' }), 1)).toBe(false);
    expect(isToolChoiceLatchedOff(toolChoiceEndpointKey({ ...base, apiBaseUrl: 'http://b/v1' }), 1)).toBe(false);
    expect(isToolChoiceLatchedOff(toolChoiceEndpointKey({ ...base, apiFormat: 'responses' }), 1)).toBe(false);
    expect(isToolChoiceLatchedOff(toolChoiceEndpointKey(base), 1)).toBe(true);
  });
});

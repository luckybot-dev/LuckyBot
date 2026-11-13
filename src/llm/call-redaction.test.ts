import type { Logger } from '@guiiai/logg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callLlm, type LlmCallConfig } from './call';
import { installLlmRedactor, redactRequest, type LlmRedactor } from './redaction';
import { redactSecrets } from '../../plugins/src/redact';
import { describeSecrets } from '../../plugins/src/redact/rules';
import type { ConversationEntry } from '../unified-api/types';

const seen = vi.hoisted(() => ({
  wire: [] as unknown[],
  dumps: [] as Array<{ id: string | undefined; suffix: string; body: unknown }>,
}));

vi.mock('./request-dump', () => ({
  dumpLlmPayload: (id: string | undefined, suffix: string, body: unknown) => {
    seen.dumps.push({ id, suffix, body });
  },
}));

// Each transport echoes the wire body it was given through onRequestBody, as the
// real ones do, and returns a minimal valid response.
vi.mock('./chat', () => ({
  chatCompletions: vi.fn(async (p: { messages: unknown[]; system?: string; onRequestBody: (b: unknown) => void }) => {
    const body = { messages: p.messages, system: p.system };
    seen.wire.push(body);
    p.onRequestBody(body);
    return {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }),
}));
vi.mock('./messages', async importOriginal => ({
  ...(await importOriginal<typeof import('./messages')>()),
  messagesApi: vi.fn(async (p: { system: unknown; messages: unknown[]; onRequestBody: (b: unknown) => void }) => {
    const body = { system: p.system, messages: p.messages };
    seen.wire.push(body);
    p.onRequestBody(body);
    return { content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }),
}));
vi.mock('./responses', () => ({
  responsesApi: vi.fn(async (p: { input: unknown[]; instructions: string; onRequestBody: (b: unknown) => void }) => {
    const body = { input: p.input, instructions: p.instructions };
    seen.wire.push(body);
    p.onRequestBody(body);
    return { output: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }),
}));

// Split so secret scanners do not flag the fixture.
const KEY = 'ghp_' + 'Ab3dE5gH7jK9mN1pQ3sT5vX7zB2cD4fG6hJ8';
const PASSWORD_LINE = 'password=hunter2pass99';

const debugCalls: Array<{ fields: unknown; msg: string }> = [];
const log = (() => {
  const logger: unknown = {
    withFields: (fields: unknown) => ({ debug: (msg: string) => debugCalls.push({ fields, msg }) }),
  };
  return logger as Logger;
})();

const entries = (): ConversationEntry[] => [
  { kind: 'message', role: 'user', parts: [{ kind: 'text', text: `<message id="m4f8a2c01" uid="ou_7d8a6e3b1c9f4a5d2e8b7c6a5d4e3f21">key ${KEY}</message>` }] },
  {
    kind: 'message',
    role: 'assistant',
    reasoning: undefined,
    parts: [
      { kind: 'text', text: `noted ${PASSWORD_LINE}` },
      { kind: 'toolCall', callId: 'call_1', name: 'bash', args: JSON.stringify({ cmd: `curl -H "x: y" https://u:Pa55word12@host/${'x'}`, note: KEY }) },
    ],
  },
  { kind: 'toolResult', callId: 'call_1', payload: `output ${KEY}`, requiresFollowUp: true },
];

const SYSTEM = `You are a bot. Admin token: ${KEY}`;

const config = (apiFormat: LlmCallConfig['apiFormat']): LlmCallConfig => ({
  apiBaseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', apiFormat,
}) as LlmCallConfig;

const enforce: LlmRedactor = { redact: redactSecrets };
const shadow: LlmRedactor = { redact: t => t, inspect: describeSecrets };

beforeEach(() => {
  seen.wire.length = 0;
  seen.dumps.length = 0;
  debugCalls.length = 0;
});
afterEach(() => installLlmRedactor(undefined));

describe.each(['openai-chat', 'responses', 'anthropic-messages'] as const)('callLlm with %s', format => {
  it('sends redacted text and dumps the redacted body, leaving the caller\'s entries alone', async () => {
    installLlmRedactor(enforce);
    const input = entries();
    const snapshot = structuredClone(input);

    await callLlm(config(format), input, SYSTEM, undefined, { log, label: 'test', dumpId: 'd1' });

    const wire = JSON.stringify(seen.wire[0]);
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain('hunter2pass99');
    expect(wire).not.toContain('Pa55word12');
    expect(wire).toContain('[redacted:api-key]');
    expect(wire).toContain('[redacted:secret]');
    // ids in the chatlog survive
    expect(wire).toContain('m4f8a2c01');
    expect(wire).toContain('ou_7d8a6e3b1c9f4a5d2e8b7c6a5d4e3f21');

    const requestDump = seen.dumps.find(d => d.suffix === 'request');
    expect(requestDump?.id).toBe('d1');
    expect(JSON.stringify(requestDump?.body)).toBe(wire);

    // the caller's entries (what gets persisted) are not mutated
    expect(input).toEqual(snapshot);
    expect(JSON.stringify(input)).toContain(KEY);
  });

  it('is byte-identical to a build without a redactor when none is installed', async () => {
    const withNone = entries();
    await callLlm(config(format), withNone, SYSTEM, undefined, { log, label: 'test', dumpId: 'd1' });
    const baseline = JSON.stringify(seen.wire[0]);
    expect(baseline).toContain(KEY);

    seen.wire.length = 0;
    installLlmRedactor({ redact: t => t });
    await callLlm(config(format), entries(), SYSTEM, undefined, { log, label: 'test', dumpId: 'd1' });
    expect(JSON.stringify(seen.wire[0])).toBe(baseline);
  });

  it('shadow mode leaves the request untouched and logs counts and hit descriptions only', async () => {
    await callLlm(config(format), entries(), SYSTEM, undefined, { log, label: 'test' });
    const baseline = JSON.stringify(seen.wire[0]);

    seen.wire.length = 0;
    debugCalls.length = 0;
    installLlmRedactor(shadow);
    await callLlm(config(format), entries(), SYSTEM, undefined, { log, label: 'test' });
    expect(JSON.stringify(seen.wire[0])).toBe(baseline);

    expect(debugCalls).toHaveLength(1);
    const logged = JSON.stringify(debugCalls[0]);
    expect(logged).toContain('"shadow"');
    expect(logged).toContain('api-key');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('Ab3dE5gH7jK9');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('Pa55word12');
    const hit = (debugCalls[0]!.fields as { shadowHits: Array<{ kind: string; length: number; hash: string }> }).shadowHits[0]!;
    expect(Object.keys(hit).sort()).toEqual(['hash', 'kind', 'length']);
    expect(hit.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('redactRequest', () => {
  it('returns the very same objects when nothing changes', () => {
    installLlmRedactor(enforce);
    const input: ConversationEntry[] = [{ kind: 'message', role: 'user', parts: [{ kind: 'text', text: 'hello there' }] }];
    const out = redactRequest(input, 'system', log, 'test');
    expect(out.entries).toBe(input);
    expect(out.system).toBe('system');
    expect(debugCalls).toHaveLength(0);
  });

  it('logs per-kind counts of removed secrets at debug, never the text', () => {
    installLlmRedactor(enforce);
    redactRequest(entries(), SYSTEM, log, 'primary');
    expect(debugCalls).toHaveLength(1);
    const fields = debugCalls[0]!.fields as { label: string; redacted: Record<string, number> };
    expect(fields.label).toBe('primary');
    expect(fields.redacted['api-key']).toBeGreaterThanOrEqual(4);
    expect(fields.redacted.secret).toBe(1);
    expect(fields.redacted.password).toBe(1);
    expect(JSON.stringify(debugCalls)).not.toContain(KEY);
  });

  it('keeps tool-call arguments valid JSON and redacts only string values', () => {
    installLlmRedactor(enforce);
    const out = redactRequest(entries(), SYSTEM, log, 'test');
    const call = (out.entries[1] as { parts: Array<{ kind: string; args?: string }> }).parts[1]!;
    const args = JSON.parse(call.args!) as { cmd: string; note: string };
    expect(args.note).toBe('[redacted:api-key]');
    expect(args.cmd).toBe('curl -H "x: y" https://u:[redacted:password]@host/x');
  });

  it('does not touch images or reasoning', () => {
    installLlmRedactor(enforce);
    const image = { kind: 'image', image: {} as never, detail: undefined } as const;
    const reasoning = { kind: 'reasoning', data: { source: 'anthropicMessages', data: { type: 'thinking', thinking: KEY, signature: 's' } } } as const;
    const input: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [image] },
      { kind: 'message', role: 'assistant', parts: [reasoning], reasoning: { reasoning_content: KEY } },
      { kind: 'toolResult', callId: 'c', payload: [image], requiresFollowUp: false },
    ];
    const out = redactRequest(input, '', log, 'test');
    expect(out.entries).toBe(input);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginHost } from './host';
import { redactPlugin } from '../../plugins/src/redact';
import { CURRENT_SDK_VERSION, definePlugin } from '../../plugins/src/sdk';
import type { Config } from '../config/config';
import type { EventSink } from '../event-sink';
import { getLlmRedactor, installLlmRedactor } from '../llm/redaction';

// Split so secret scanners do not flag the fixture.
const KEY = 'ghp_' + 'Ab3dE5gH7jK9mN1pQ3sT5vX7zB2cD4fG6hJ8';

const makeConfig = (plugins: Record<string, unknown>): Config => ({
  models: {},
  maintainers: [],
  platform: 'feishu',
  plugins: { server: { host: '127.0.0.1', port: 0 }, ...plugins },
  chats: {
    default: { plugins: {} },
    oc_a: { plugins: {} },
    oc_b: { plugins: {} },
  },
} as unknown as Config);

const logger: any = {
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  withFields: () => logger, withError: () => logger, withContext: () => logger,
};
const eventSink: EventSink = { persist: vi.fn(), publish: vi.fn(), accept: vi.fn() };

const makeHost = (plugins: Record<string, unknown>, extra: ReturnType<typeof definePlugin>[] = []) =>
  createPluginHost({
    config: makeConfig(plugins),
    eventSink,
    logger,
    plugins: [redactPlugin, ...extra],
  });

afterEach(() => installLlmRedactor(undefined));

describe('redact plugin in the host', () => {
  it('installs nothing when the plugin is not configured', async () => {
    const host = makeHost({});
    await host.start();
    expect(getLlmRedactor()).toBeUndefined();
    expect(host.getSystemPromptHints('oc_a')).toEqual([]);
    await host.stop();
  });

  it('mode off installs an identity redactor and no hint', async () => {
    const host = makeHost({ redact: { mode: 'off' } });
    await host.start();
    const redactor = getLlmRedactor()!;
    expect(redactor.redact(`x ${KEY}`)).toBe(`x ${KEY}`);
    expect(redactor.inspect!(`x ${KEY}`)).toEqual([]);
    expect(host.getSystemPromptHints('oc_a')).toEqual([]);
    await host.stop();
  });

  it('enforce redacts, and its hint reaches every chat without per-chat enablement', async () => {
    const host = makeHost({ redact: { mode: 'enforce' } });
    await host.start();
    expect(getLlmRedactor()!.redact(`x ${KEY}`)).toBe('x [redacted:api-key]');
    for (const chat of ['oc_a', 'oc_b', 'default']) {
      const hints = host.getSystemPromptHints(chat);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain('[redacted:<kind>]');
    }
    await host.stop();
  });

  it('shadow leaves text alone and exposes hit descriptions', async () => {
    const host = makeHost({ redact: { mode: 'shadow' } });
    await host.start();
    const redactor = getLlmRedactor()!;
    expect(redactor.redact(`x ${KEY}`)).toBe(`x ${KEY}`);
    expect(redactor.inspect!(`x ${KEY}`).map(h => h.kind)).toEqual(['api-key']);
    expect(host.getSystemPromptHints('oc_a')).toEqual([]);
    await host.stop();
  });

  it('stop() removes the redactor and the hint', async () => {
    const host = makeHost({ redact: { mode: 'enforce' } });
    await host.start();
    await host.stop();
    expect(getLlmRedactor()).toBeUndefined();
    expect(host.getSystemPromptHints('oc_a')).toEqual([]);
  });

  it('rejects the old `enabled: true` switch at startup', async () => {
    const host = makeHost({ redact: { enabled: true } });
    await expect(host.start()).rejects.toThrow('configuration failed validation');
  });

  it('composes the redactText of several plugins in registration order', async () => {
    const upper = definePlugin({
      id: 'second',
      sdkVersion: CURRENT_SDK_VERSION,
      setup: () => {},
      contributes: { redactText: (t: string) => t.replace('[redacted:api-key]', '<gone>') },
    });
    const host = makeHost({ redact: { mode: 'enforce' }, second: {} }, [upper]);
    await host.start();
    expect(getLlmRedactor()!.redact(`x ${KEY}`)).toBe('x <gone>');
    await host.stop();
  });

  it('leaves a redactor installed by someone else alone on stop', async () => {
    const host = makeHost({ redact: { mode: 'enforce' } });
    await host.start();
    const other = { redact: (t: string) => t };
    installLlmRedactor(other);
    await host.stop();
    expect(getLlmRedactor()).toBe(other);
  });
});

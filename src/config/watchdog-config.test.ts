import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'watchdog-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig } = await import('./config');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const fixture = (watchdog?: unknown) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'primary-model' } },
    platform: 'feishu',
    feishu: { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-secret' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    ...(watchdog === undefined ? {} : { watchdog }),
    chats: { default: { tools: {} }, oc_a: {} },
  }));
  return loadConfig();
};

describe('watchdog configuration', () => {
  it('defaults to enabled with a 60 s tick and a 10 min rearm age', () => {
    expect(fixture().watchdog).toEqual({
      enabled: true,
      intervalSec: 60,
      rearmAfterSec: 600,
      failureStreakThreshold: 3,
      summaryIntervalSec: 900,
    });
  });

  it('merges partial overrides over the defaults', () => {
    expect(fixture({ enabled: false, rearmAfterSec: 120 }).watchdog).toMatchObject({
      enabled: false,
      intervalSec: 60,
      rearmAfterSec: 120,
    });
  });

  it.each([
    ['a zero interval', { intervalSec: 0 }],
    ['a fractional rearm age', { rearmAfterSec: 1.5 }],
    ['a negative threshold', { failureStreakThreshold: -1 }],
    ['a non-boolean enabled', { enabled: 'yes' }],
    ['a zero summary interval', { summaryIntervalSec: 0 }],
  ])('rejects %s', (_name, watchdog) => {
    expect(() => fixture(watchdog)).toThrow();
  });
});

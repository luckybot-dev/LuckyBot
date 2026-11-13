import { describe, expect, it } from 'vitest';

import { createWakeupHealth, isRequestTimeout } from './wakeup-health';

describe('createWakeupHealth', () => {
  it('counts failures by stage and separates probe timeouts from other probe errors', () => {
    const health = createWakeupHealth();
    health.recordFailure({ stage: 'probe', probeTimeout: true });
    health.recordFailure({ stage: 'probe', probeTimeout: true });
    health.recordFailure({ stage: 'probe', probeTimeout: false });
    health.recordFailure({ stage: 'prepare', probeTimeout: false });
    health.recordFailure({ stage: 'primary', probeTimeout: false });
    health.recordProbeMalformed();
    health.recordAbandoned();
    health.recordProbeLatency(900);
    health.recordProbeLatency(15_000);
    health.recordProbeLatency(40);

    expect(health.counters()).toEqual({
      probeTimeouts: 2,
      probeFailures: 1,
      probeMalformed: 1,
      prepareFailures: 1,
      primaryFailures: 1,
      abandoned: 1,
      maxProbeLatencyMs: 15_000,
    });
  });

  it('reports only what is new since the previous summary, and null when quiet', () => {
    const health = createWakeupHealth();
    expect(health.takeSummary()).toBeNull();

    health.recordFailure({ stage: 'primary', probeTimeout: false });
    health.recordProbeLatency(300);
    expect(health.takeSummary()).toMatchObject({ primaryFailures: 1, probeTimeouts: 0, maxProbeLatencyMs: 300 });
    // Latency alone is not an event.
    health.recordProbeLatency(20_000);
    expect(health.takeSummary()).toBeNull();
    health.recordAbandoned();
    expect(health.takeSummary()).toMatchObject({ abandoned: 1, primaryFailures: 0, maxProbeLatencyMs: 0 });
    // Totals are untouched by summaries.
    expect(health.counters()).toMatchObject({ primaryFailures: 1, abandoned: 1, maxProbeLatencyMs: 20_000 });
  });
});

describe('isRequestTimeout', () => {
  it('matches the transports\' timeout abort message only', () => {
    expect(isRequestTimeout(new Error('responses request timed out after 15s'))).toBe(true);
    expect(isRequestTimeout(new Error('Chat Completions API 503: busy'))).toBe(false);
    expect(isRequestTimeout('chat request timed out after 15s')).toBe(false);
  });
});

// In-memory per-chat wake-up health: which stage a failed wake-up died in and
// how often that happens. Counters live only in the process (no DB); the
// watchdog reads them and logs a summary, and a restart resets them.

// `prepare` is everything before the probe request (loading responses, context
// composition, prompt rendering); `probe` covers the probe request and the
// persistence of its decision; `primary` is everything after the probe gate.
export type WakeupStage = 'prepare' | 'probe' | 'primary';

// What the driver tells the scheduler about a failed attempt.
export interface WakeupFailureInfo {
  stage: WakeupStage;
  // The probe request itself timed out (its HTTP bound), as opposed to any
  // other probe error.
  probeTimeout: boolean;
  elapsedMs: number;
}

export interface WakeupCounters {
  probeTimeouts: number;
  // Probe errors other than a timeout.
  probeFailures: number;
  // Missing or malformed decisions; the probe fails closed to no_action, so
  // these are not errors but are otherwise indistinguishable from silence.
  probeMalformed: number;
  prepareFailures: number;
  primaryFailures: number;
  // Wake-ups given up on: permanent failure or exhausted transient retries.
  abandoned: number;
  maxProbeLatencyMs: number;
}

const COUNT_KEYS = [
  'probeTimeouts',
  'probeFailures',
  'probeMalformed',
  'prepareFailures',
  'primaryFailures',
  'abandoned',
] as const;

const zero = (): WakeupCounters => ({
  probeTimeouts: 0,
  probeFailures: 0,
  probeMalformed: 0,
  prepareFailures: 0,
  primaryFailures: 0,
  abandoned: 0,
  maxProbeLatencyMs: 0,
});

// Provider transports abort with `<format> request timed out after <n>s`
// (src/llm/{chat,messages,responses}.ts).
export const isRequestTimeout = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('request timed out after');

export const createWakeupHealth = () => {
  const total = zero();
  // Totals at the last summary, so a summary reports only what is new.
  let reported = zero();
  let maxProbeLatencySinceSummaryMs = 0;

  return {
    // Includes failed probes: a timeout is exactly the slow case worth seeing.
    recordProbeLatency(ms: number): void {
      total.maxProbeLatencyMs = Math.max(total.maxProbeLatencyMs, ms);
      maxProbeLatencySinceSummaryMs = Math.max(maxProbeLatencySinceSummaryMs, ms);
    },
    recordProbeMalformed(): void {
      total.probeMalformed++;
    },
    recordFailure(info: Pick<WakeupFailureInfo, 'stage' | 'probeTimeout'>): void {
      if (info.stage === 'probe') {
        if (info.probeTimeout) total.probeTimeouts++;
        else total.probeFailures++;
      } else if (info.stage === 'prepare') {
        total.prepareFailures++;
      } else {
        total.primaryFailures++;
      }
    },
    recordAbandoned(): void {
      total.abandoned++;
    },
    counters: (): Readonly<WakeupCounters> => ({ ...total }),
    // Counts accumulated since the previous call, or null when nothing worth
    // reporting happened (latency alone is not an event).
    takeSummary(): WakeupCounters | null {
      const delta: WakeupCounters = { ...zero(), maxProbeLatencyMs: maxProbeLatencySinceSummaryMs };
      let any = false;
      for (const key of COUNT_KEYS) {
        delta[key] = total[key] - reported[key];
        if (delta[key] > 0) any = true;
      }
      reported = { ...total };
      maxProbeLatencySinceSummaryMs = 0;
      return any ? delta : null;
    },
  };
};

export type WakeupHealth = ReturnType<typeof createWakeupHealth>;

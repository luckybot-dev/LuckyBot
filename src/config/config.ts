import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_TURN_BUDGET } from '../driver/turn-budget';
import type { CompactionConfig, DebounceConfig, TurnBudget } from '../driver/types';
import { registerHttpSecret } from '../http';
import type { LlmEndpoint } from '../llm/types';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types';
import type { MemoryConfig } from '../memory/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
  forceToolChoice: v.optional(v.boolean(), true),
  extraBody: v.optional(v.record(v.string(), v.unknown())),
};

// --- Runtime config schema (top-level, global) ---

const DEFAULT_FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

const RuntimeSchema = v.object({
  shell: v.optional(v.pipe(v.array(v.string()), v.minLength(1)), ['/bin/bash', '-c']),
  writeFile: v.pipe(v.array(v.string()), v.minLength(1)),
  readFile: v.pipe(v.array(v.string()), v.minLength(1)),
  writeFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
  readFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
});

// --- Chat-level config schemas ---

// Partial override of DEFAULT_TURN_BUDGET. The cross-field rule
// deadlineMs > minModelCallMs is checked after merging with the defaults.
const TurnBudgetOverrideSchema = v.partial(v.object({
  maxToolRounds: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxToolCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxParticipationCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deadlineMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  minModelCallMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  wrapUpReserveMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
}));

// Probe HTTP bound, separate from primary.turnBudget.deadlineMs; the endpoint's
// timeoutSec still applies if lower. Below 1 s no real probe can finish; above
// 2 min a stuck probe would hold the chat's serialized scheduler too long.
const ProbeTimeoutMsSchema = v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(120_000));

// Estimated-token budget of the probe's recent slice. Below 1K the judge cannot
// see enough of the conversation to decide reliably.
const ProbeContextEstTokensSchema = v.pipe(v.number(), v.integer(), v.minValue(1_000));

// Separate cap for the always-included compaction summary in the probe request,
// truncated from the end above it. Below 1K the summary is useless as context.
const ProbeSummaryMaxEstTokensSchema = v.pipe(v.number(), v.integer(), v.minValue(1_000));

// How recent a maintainer message must be to keep the shell gate open (seconds).
// Bounds the window after a silent turn or a `no_action` probe, which does not
// advance the bot's last action.
const BashMaintainerWindowSecSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

// Group-participation knobs (see AGENTS.md "Participation And Turn Budget").
// `style` steers the probe's bar for unaddressed chatter; `brakeMessages10m` is
// the soft self-volume brake; `cooldownSec`/`maxPerHour` are opt-in hard
// limits on unaddressed speech (0 = off).
const ParticipationStyleSchema = v.picklist(['quiet', 'normal', 'lively']);
const BrakeMessages10mSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const NonNegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
// Bot-to-bot rounds a human-requested exchange may run before waiting for a human.
const BotRoundsSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
// Whether the bot may engage other bots without a human asking for it.
const BotInteractionSchema = v.picklist(['requested', 'open']);

// Number of newest turn responses whose provider reasoning is replayed.
const ReasoningReplayTurnsSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

// Person-memory knobs (see AGENTS.md "Person Memory"). Cross-field rules between
// the budgets are checked on the merged chat config in validateConfig.
const MemoryCharsSchema = v.pipe(v.number(), v.integer(), v.minValue(100));
const MemoryCountSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
// Below 5 human messages the consolidator would skip every run anyway.
const MemoryTriggerMessagesSchema = v.pipe(v.number(), v.integer(), v.minValue(5));
const MemoryNonNegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

export const SceneProfileSchema = v.strictObject({
  hint: v.optional(v.string()),
  participation: v.optional(v.partial(v.object({
    style: ParticipationStyleSchema,
    brakeMessages10m: BrakeMessages10mSchema,
    cooldownSec: NonNegativeIntSchema,
    maxPerHour: NonNegativeIntSchema,
    botRounds: BotRoundsSchema,
    botInteraction: BotInteractionSchema,
  }))),
  primary: v.optional(v.strictObject({
    extraBody: v.optional(v.record(v.string(), v.unknown())),
  })),
});

export type SceneProfile = v.InferOutput<typeof SceneProfileSchema>;

const ChatConfigSchema = v.object({
  primary: v.optional(v.object({
    model: v.optional(v.string(), 'primary'),
    turnBudget: v.optional(TurnBudgetOverrideSchema, {}),
    reasoningReplayTurns: v.optional(ReasoningReplayTurnsSchema, 3),
  }), {}),
  systemFiles: v.optional(v.array(v.string()), []),
  sendTypingAction: v.optional(v.boolean(), true),
  blockedUserIds: v.optional(v.array(v.string()), []),
  debounce: v.optional(v.object({
    initialDelayMs: v.optional(v.number(), 1000),
    typingExtendMs: v.optional(v.number(), 5000),
    maxDelayMs: v.optional(v.number(), 30000),
  }), {}),
  compaction: v.optional(v.object({
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
  }), {}),
  probe: v.optional(v.object({
    model: v.optional(v.string()),
    timeoutMs: v.optional(ProbeTimeoutMsSchema, DEFAULT_PROBE_TIMEOUT_MS),
    contextEstTokens: v.optional(ProbeContextEstTokensSchema, 20000),
    summaryMaxEstTokens: v.optional(ProbeSummaryMaxEstTokensSchema, 20000),
  }), {}),
  memory: v.optional(v.object({
    enabled: v.optional(v.boolean(), DEFAULT_MEMORY_CONFIG.enabled),
    inject: v.optional(v.boolean(), DEFAULT_MEMORY_CONFIG.inject),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    triggerMessages: v.optional(MemoryTriggerMessagesSchema, DEFAULT_MEMORY_CONFIG.triggerMessages),
    maxWindowMessages: v.optional(MemoryCountSchema, DEFAULT_MEMORY_CONFIG.maxWindowMessages),
    cardMaxChars: v.optional(MemoryCharsSchema, DEFAULT_MEMORY_CONFIG.cardMaxChars),
    selfMaxChars: v.optional(MemoryCharsSchema, DEFAULT_MEMORY_CONFIG.selfMaxChars),
    hearsayMaxEntries: v.optional(MemoryNonNegativeIntSchema, DEFAULT_MEMORY_CONFIG.hearsayMaxEntries),
    hearsayMaxChars: v.optional(MemoryCountSchema, DEFAULT_MEMORY_CONFIG.hearsayMaxChars),
    injectionMaxChars: v.optional(MemoryCharsSchema, DEFAULT_MEMORY_CONFIG.injectionMaxChars),
    selfInjectionChars: v.optional(MemoryCharsSchema, DEFAULT_MEMORY_CONFIG.selfInjectionChars),
    lookbackMessages: v.optional(MemoryCountSchema, DEFAULT_MEMORY_CONFIG.lookbackMessages),
    recentSpeakers: v.optional(MemoryCountSchema, DEFAULT_MEMORY_CONFIG.recentSpeakers),
    doNotReadd: v.optional(MemoryNonNegativeIntSchema, DEFAULT_MEMORY_CONFIG.doNotReadd),
  }), {}),
  participation: v.optional(v.object({
    style: v.optional(ParticipationStyleSchema, 'normal'),
    brakeMessages10m: v.optional(BrakeMessages10mSchema, 10),
    cooldownSec: v.optional(NonNegativeIntSchema, 0),
    maxPerHour: v.optional(NonNegativeIntSchema, 0),
    botRounds: v.optional(BotRoundsSchema, 2),
    botInteraction: v.optional(BotInteractionSchema, 'requested'),
  }), {}),
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  animationToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  customEmojiToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  scenes: v.optional(v.record(v.string(), SceneProfileSchema), {}),
  tools: v.object({
    banSpammer: v.optional(v.boolean(), false),
    bash: v.optional(v.object({
      // Runs on the host with no sandbox. Keep false until an isolated
      // execution backend exists.
      enabled: v.optional(v.boolean(), true),
      backgroundThresholdSec: v.optional(v.number(), 10),
      // Expose shell tools only when a message from a trusted maintainer
      // arrived after the bot's last action.
      requireMaintainer: v.optional(v.boolean(), true),
      maintainerWindowSec: v.optional(BashMaintainerWindowSecSchema, 600),
    }), {}),
  }),
  plugins: v.optional(v.record(v.string(), v.looseObject({
    enabled: v.optional(v.boolean(), false),
  })), {}),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  primary: v.partial(v.object({
    model: v.pipe(v.string(), v.minLength(1)),
    turnBudget: TurnBudgetOverrideSchema,
    reasoningReplayTurns: ReasoningReplayTurnsSchema,
  })),
  systemFiles: v.array(v.string()),
  sendTypingAction: v.boolean(),
  blockedUserIds: v.array(v.string()),
  debounce: v.partial(v.object({
    initialDelayMs: v.number(),
    typingExtendMs: v.number(),
    maxDelayMs: v.number(),
  })),
  compaction: v.partial(v.object({
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.pipe(v.string(), v.minLength(1)),
  })),
  probe: v.partial(v.object({
    model: v.pipe(v.string(), v.minLength(1)),
    timeoutMs: ProbeTimeoutMsSchema,
    contextEstTokens: ProbeContextEstTokensSchema,
    summaryMaxEstTokens: ProbeSummaryMaxEstTokensSchema,
  })),
  memory: v.partial(v.object({
    enabled: v.boolean(),
    inject: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    triggerMessages: MemoryTriggerMessagesSchema,
    maxWindowMessages: MemoryCountSchema,
    cardMaxChars: MemoryCharsSchema,
    selfMaxChars: MemoryCharsSchema,
    hearsayMaxEntries: MemoryNonNegativeIntSchema,
    hearsayMaxChars: MemoryCountSchema,
    injectionMaxChars: MemoryCharsSchema,
    selfInjectionChars: MemoryCharsSchema,
    lookbackMessages: MemoryCountSchema,
    recentSpeakers: MemoryCountSchema,
    doNotReadd: MemoryNonNegativeIntSchema,
  })),
  participation: v.partial(v.object({
    style: ParticipationStyleSchema,
    brakeMessages10m: BrakeMessages10mSchema,
    cooldownSec: NonNegativeIntSchema,
    maxPerHour: NonNegativeIntSchema,
    botRounds: BotRoundsSchema,
    botInteraction: BotInteractionSchema,
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxConcurrency: v.number(),
  })),
  animationToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  customEmojiToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  tools: v.partial(v.object({
    banSpammer: v.boolean(),
    bash: v.partial(v.object({
      enabled: v.boolean(),
      backgroundThresholdSec: v.number(),
      requireMaintainer: v.boolean(),
      maintainerWindowSec: BashMaintainerWindowSecSchema,
    })),
  })),
  scenes: v.optional(v.record(v.string(), SceneProfileSchema)),
  plugins: v.optional(v.record(v.string(), v.partial(v.looseObject({
    enabled: v.boolean(),
  })))),
})), {});

const BackgroundTasksSchema = v.optional(v.object({
  outputDir: v.optional(v.string(), './data/task-outputs'),
  retentionCount: v.optional(v.number(), 20),
}), {});

// Out-of-loop watchdog (src/driver/watchdog.ts). Deterministic checks only; it
// never calls a model. `rearmAfterSec` is how long an abandoned wake-up must
// have been stuck before it gets its single rearm.
const WatchdogSchema = v.optional(v.object({
  enabled: v.optional(v.boolean(), true),
  intervalSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 60),
  rearmAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 600),
  /** Consecutive compaction or memory failures that raise a warning. */
  failureStreakThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 3),
  /** Minimum gap between wake-up health summaries (logged only when something happened). */
  summaryIntervalSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 900),
}), {});

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  /**
   * Trusted maintainer ids (Feishu open_id `ou_...` or Telegram user id strings).
   * Deployment configuration is the only source of maintainer status; chat
   * content and retrieved memories never grant it. See CLAUDE.md "Maintainers".
   */
  maintainers: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
      v.check(ids => new Set(ids).size === ids.length, 'maintainer ids must be unique'),
    ),
    [],
  ),
  /** Chat platform this process connects to. Exactly one platform runs per process. */
  platform: v.optional(v.picklist(['telegram', 'feishu']), 'telegram'),
  /** Required when platform is "telegram". */
  telegram: v.optional(v.object({
    botToken: v.string(),
    apiId: v.number(),
    apiHash: v.string(),
    /** Whether to enable userbot. Requires running `pnpm login` once to populate the tdlib state dir. */
    userbotEnabled: v.optional(v.boolean(), false),
    /** Override the default tdlib state directory for the bot client (defaults to data/tdlib-bot). */
    botDataDir: v.optional(v.string()),
    /** Override the default tdlib state directory for the userbot client (defaults to data/tdlib-userbot). */
    userbotDataDir: v.optional(v.string()),
  })),
  /** Required when platform is "feishu". Same trust level as the Telegram token and model API keys. */
  feishu: v.optional(v.object({
    // Explicit messages throughout: valibot's defaults embed the received
    // value, and a mistyped secret must not reach the fatal-error log.
    // The SDK's WSClient silently refuses to start with a malformed app id.
    appId: v.pipe(
      v.string('feishu.appId must be a string'),
      v.trim(),
      v.regex(/^cli_[0-9a-fA-F]{16}$/, 'feishu.appId must be a cli_ application id'),
    ),
    appSecret: v.pipe(v.string('feishu.appSecret must be a string'), v.trim(), v.minLength(1, 'feishu.appSecret is required')),
    /** `feishu`, `lark`, or an explicit https:// open-platform base URL. */
    domain: v.optional(v.pipe(
      v.string('feishu.domain must be a string'),
      v.trim(),
      v.regex(/^(?:feishu|lark|https:\/\/[^\s/]+\/?)$/, 'feishu.domain must be "feishu", "lark", or an https:// base URL'),
    ), 'feishu'),
  }, 'feishu must be a mapping')),
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
    /**
     * History retention, run once at startup per chat. Both cutoffs are
     * absolute ages in days; `0` (the default) keeps everything, matching the
     * behaviour before retention existed.
     *
     * Only rows no reader can reach are eligible — see `src/db/retention.ts`
     * for why the compaction cursor bounds `turn_responses_v2` and why
     * `probe_responses_v2` is bounded by its own newest row.
     */
    retention: v.optional(v.object({
      turnResponsesDays: v.optional(v.number(), 0),
      probeResponsesDays: v.optional(v.number(), 0),
      /** Run `VACUUM` after a prune when this share of pages is free. */
      vacuumMinFreeRatio: v.optional(v.number(), 0),
    }), {}),
  }), {}),
  /**
   * Root of the person-memory Markdown store (`<memoryDir>/<chatId>/...`). Must
   * sit under the writable data volume; the global key keeps it apart from the
   * per-chat `memory` section.
   */
  memoryDir: v.optional(v.string(), './data/memory'),
  plugins: v.optional(v.record(v.string(), v.unknown()), {}),
  watchdog: WatchdogSchema,
  runtime: RuntimeSchema,
  backgroundTasks: BackgroundTasksSchema,
  chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type TelegramConfig = NonNullable<Config['telegram']>;
export type FeishuConfig = NonNullable<Config['feishu']>;
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>;

export type WatchdogConfig = Config['watchdog'];
export type RuntimeConfig = Config['runtime'];
export type BackgroundTasksConfig = Config['backgroundTasks'];

export interface ParticipationConfig {
  style: 'quiet' | 'normal' | 'lively';
  brakeMessages10m: number;
  cooldownSec: number;
  maxPerHour: number;
  botRounds: number;
  botInteraction: 'requested' | 'open';
}

export interface ResolvedChatConfig {
  primary: { model: LlmEndpoint; turnBudget: TurnBudget; reasoningReplayTurns: number };
  systemFiles: { filename: string; content: string }[];
  sendTypingAction: boolean;
  blockedUserIds: string[];
  debounce: DebounceConfig;
  compaction: CompactionConfig;
  probe: { model: LlmEndpoint; timeoutMs: number; contextEstTokens: number; summaryMaxEstTokens: number };
  participation: ParticipationConfig;
  memory: MemoryConfig;
  imageToText: { enabled: boolean; model?: string; maxConcurrency: number };
  animationToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  customEmojiToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  plugins: Record<string, { enabled: boolean }>;
  scenes?: Record<string, SceneProfile>;
  tools: {
    banSpammer: boolean;
    bash: { enabled: boolean; backgroundThresholdSec: number; requireMaintainer: boolean; maintainerWindowSec: number };
  };
}

const SECRET_KEY_PATTERN = /secret|token|apikey|password/i;

const registerPluginSecrets = (node: unknown): void => {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      if (SECRET_KEY_PATTERN.test(key)) {
        registerHttpSecret(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      registerPluginSecrets(value);
    }
  }
};

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml';

export const mergeChatConfig = (config: Config, chatId: string): ChatConfig => {
  const override = config.chats[chatId];
  if (!override) throw new Error(`Unknown chat "${chatId}" — not found in chats registry`);
  return merge(structuredClone(config.chats.default), override);
};

const resolveTurnBudget = (chatId: string, merged: ChatConfig): TurnBudget => {
  const budget = { ...DEFAULT_TURN_BUDGET, ...merged.primary.turnBudget };
  // An interrupted continuation skips probe and must be able to start at least
  // one model step; otherwise the open chain could never close.
  if (budget.deadlineMs <= budget.minModelCallMs)
    throw new Error(`Chat ${chatId}: primary.turnBudget.deadlineMs (${budget.deadlineMs}) must be greater than minModelCallMs (${budget.minModelCallMs})`);
  // The reserve must leave room for the wrap-up's own model call and must not
  // swallow the whole deadline (every step would be a wrap-up).
  const reserve = budget.wrapUpReserveMs ?? 0;
  if (reserve > 0 && (reserve < budget.minModelCallMs || reserve >= budget.deadlineMs))
    throw new Error(`Chat ${chatId}: primary.turnBudget.wrapUpReserveMs (${reserve}) must be 0 or between minModelCallMs (${budget.minModelCallMs}) and deadlineMs (${budget.deadlineMs})`);
  return budget;
};

// Memory budgets must leave every injected card a meaningful share and keep the
// write path able to hold what it is asked to write.
const validateMemory = (chatId: string, memory: ChatConfig['memory']): void => {
  const fail = (rule: string): never => {
    throw new Error(`Chat ${chatId}: memory ${rule}`);
  };
  if (memory.injectionMaxChars < memory.selfInjectionChars)
    fail(`injectionMaxChars (${memory.injectionMaxChars}) must be >= selfInjectionChars (${memory.selfInjectionChars})`);
  if (memory.injectionMaxChars < memory.recentSpeakers * 200)
    fail(`injectionMaxChars (${memory.injectionMaxChars}) must be >= recentSpeakers * 200 (${memory.recentSpeakers * 200})`);
  // At least half a full card must be shown per speaker, or eviction pressure
  // on the cards is constant and most of what is stored is never seen.
  if (memory.injectionMaxChars / memory.recentSpeakers < memory.cardMaxChars / 2)
    fail(`injectionMaxChars / recentSpeakers (${memory.injectionMaxChars / memory.recentSpeakers}) must be >= cardMaxChars / 2 (${memory.cardMaxChars / 2})`);
  if (memory.maxWindowMessages < memory.triggerMessages)
    fail(`maxWindowMessages (${memory.maxWindowMessages}) must be >= triggerMessages (${memory.triggerMessages})`);
};

// Cross-field rules the schema cannot express.
const validateConfig = (config: Config): void => {
  const maintainers = new Set(config.maintainers);
  for (const chatId of getChatIds(config)) {
    const merged = mergeChatConfig(config, chatId);
    resolveTurnBudget(chatId, merged);
    validateMemory(chatId, merged.memory);
    // A blocked maintainer would render as blocked, silently hiding the trusted
    // flag; reject the ambiguous config instead of picking a precedence.
    const blockedMaintainer = merged.blockedUserIds.find(id => maintainers.has(id));
    if (blockedMaintainer)
      throw new Error(`Config: maintainer "${blockedMaintainer}" is also in chats.${chatId}.blockedUserIds — remove it from one of them`);
  }

  if (config.platform === 'telegram' && !config.telegram)
    throw new Error('Config: the "telegram" section is required when platform is "telegram"');
  if (config.platform === 'feishu' && !config.feishu)
    throw new Error('Config: the "feishu" section is required when platform is "feishu"');
  if (config.platform === 'feishu') {
    for (const chatId of getChatIds(config)) {
      const merged = mergeChatConfig(config, chatId);
      // ban_spammer is a Telegram moderation backend; Feishu has no equivalent yet.
      if (merged.tools.banSpammer)
        throw new Error(`Chat ${chatId}: tools.banSpammer is not supported when platform is "feishu"`);
    }
  }

  if (config.plugins) {
    registerPluginSecrets(config.plugins);
  }
};

export const loadConfig = (): Config => {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  // Rethrow without `issues`: each issue carries its raw `input`, which for a
  // credential field would be the secret, and the fatal-error logger
  // serializes the error object.
  const result = v.safeParse(ConfigSchema, parsed);
  if (!result.success)
    throw new Error(`Invalid config: ${result.issues.map(issue => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`).join('; ')}`);
  const config = result.output;
  validateConfig(config);
  return config;
};

export const requireTelegramConfig = (config: Config): TelegramConfig => {
  if (!config.telegram) throw new Error('Telegram configuration is unavailable');
  return config.telegram;
};

export const requireFeishuConfig = (config: Config): FeishuConfig => {
  if (!config.feishu) throw new Error('Feishu configuration is unavailable');
  return config.feishu;
};

export const resolveModel = (config: Config, name: string): LlmEndpoint => {
  const entry = config.models[name];
  if (!entry) throw new Error(`Unknown model "${name}" — not found in models registry`);
  return { ...entry, apiFormat: entry.apiFormat ?? 'openai-chat' };
};

/** Return whitelisted chat IDs (all keys in chats except "default"). */
export const getChatIds = (config: Config): string[] =>
  Object.keys(config.chats).filter(k => k !== 'default');

/**
 * Chats whose shell tools can never be exposed: bash is enabled and
 * maintainer-gated, but no maintainer id is configured. Startup warns once per
 * such chat; the gate stays closed forever (fail closed).
 */
export const findChatsWithUnreachableShellGate = (config: Config): string[] => {
  if (config.maintainers.length > 0) return [];
  return getChatIds(config).filter(chatId => {
    const merged = mergeChatConfig(config, chatId);
    return merged.tools.bash.enabled && merged.tools.bash.requireMaintainer;
  });
};

/** Deep-merge default chat config with per-chat overrides and resolve model names. */
export const resolveChatConfig = (config: Config, chatId: string): ResolvedChatConfig => {
  const merged = mergeChatConfig(config, chatId);

  const primaryModel = resolveModel(config, merged.primary.model);

  return {
    primary: {
      model: primaryModel,
      turnBudget: resolveTurnBudget(chatId, merged),
      reasoningReplayTurns: merged.primary.reasoningReplayTurns,
    },
    systemFiles: merged.systemFiles.map(path => ({
      filename: basename(path),
      content: readFileSync(path, 'utf-8').trim(),
    })),
    debounce: merged.debounce,
    sendTypingAction: merged.sendTypingAction,
    blockedUserIds: merged.blockedUserIds,
    compaction: {
      ...merged.compaction,
      model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
    },
    probe: {
      model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
      timeoutMs: merged.probe.timeoutMs,
      contextEstTokens: merged.probe.contextEstTokens,
      summaryMaxEstTokens: merged.probe.summaryMaxEstTokens,
    },
    participation: { ...merged.participation },
    memory: {
      ...merged.memory,
      model: merged.memory.model ? resolveModel(config, merged.memory.model) : undefined,
    },
    imageToText: {
      enabled: merged.imageToText.enabled,
      model: merged.imageToText.model,
      maxConcurrency: merged.imageToText.maxConcurrency,
    },
    animationToText: {
      enabled: merged.animationToText.enabled,
      model: merged.animationToText.model,
      maxFrames: merged.animationToText.maxFrames,
      maxConcurrency: merged.animationToText.maxConcurrency,
    },
    customEmojiToText: {
      enabled: merged.customEmojiToText.enabled,
      model: merged.customEmojiToText.model,
      maxFrames: merged.customEmojiToText.maxFrames,
      maxConcurrency: merged.customEmojiToText.maxConcurrency,
    },
    plugins: merged.plugins ?? {},
    scenes: merged.scenes,
    tools: {
      banSpammer: merged.tools.banSpammer,
      bash: {
        enabled: merged.tools.bash.enabled,
        backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec,
        requireMaintainer: merged.tools.bash.requireMaintainer,
        maintainerWindowSec: merged.tools.bash.maintainerWindowSec,
      },
    },
  };
};

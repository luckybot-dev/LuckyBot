# LuckyBot Plugin Specification

This document is the normative architectural and API specification for LuckyBot plugins. All plugins implemented in the plugin repository (`plugins/`, submodule pointing to `LuckyBot-Plugin`) follow the contracts and invariants defined here.

---

## 1. System Overview and Core/Plugin Boundary

LuckyBot's core operates as the **host**. The plugin repository holds the **contract (`src/sdk/`)** and independent plugin modules. Core mounts the plugin repository as a Git submodule at `plugins/`.

```text
LuckyBot (Core Host)
  ├── src/plugins/            Plugin host, capability providers, HTTP server
  ├── src/runtime-event.ts    Generic 'plugin_event' runtime representation
  └── plugins/ (submodule)    LuckyBot-Plugin repository
        ├── src/sdk/          Plugin SDK type definitions and definePlugin
        ├── src/tavern/       Tavern webhook protocol implementation
        ├── src/games/        Game modules (e.g. Liar's Bar)
        └── src/index.ts      Static registry of plugins
```

### Core Invariants

1. **Static Composition**: Plugins are registered via static imports in `plugins/src/index.ts`. There is no filesystem scanning, dynamic `import()`, or runtime reflection.
2. **Strict Encapsulation**: Plugins **never** receive:
   - The DI container (`tsyringe`).
   - The SQLite database connection (`DB`).
   - Platform clients (TDLib, Feishu SDK/WSClient).
   - The Deterministic Context Pipeline (IC/RC) or conversation chat logs.
3. **Capability Injection**: Plugins interact with LuckyBot solely through capabilities explicitly passed by the host into `setup(ctx)`.

---

## 2. Plugin Declaration

Every plugin exports a definition created with `definePlugin`:

```ts
import { CURRENT_SDK_VERSION, definePlugin } from '../sdk';
import * as v from 'valibot';

export interface MyPluginConfig {
  apiKey: string;
}

export const myPlugin = definePlugin<MyPluginConfig>({
  id: 'my_plugin',
  sdkVersion: CURRENT_SDK_VERSION,
  configSchema: v.object({
    apiKey: v.string(),
  }),
  contributes: {
    promptHints: (chatId: string) => [
      {
        placement: 'system',
        text: 'Optional prompt instructions for this chat.',
      },
    ],
  },
  setup(ctx) {
    // Register HTTP routes, initialize state
  },
  stop() {
    // Clean up timers, in-flight work
  },
});
```

### SDK Version Policy

- The current SDK version is `CURRENT_SDK_VERSION = 1`.
- Any breaking change to `PluginCapabilities`, `PluginContext`, or the extension point interfaces requires bumping `CURRENT_SDK_VERSION`.
- During startup, the host checks `plugin.sdkVersion === CURRENT_SDK_VERSION`. Any version mismatch throws an error immediately to prevent undefined runtime behavior.

---

## 3. Injected Capabilities

When an enabled plugin is started, the host passes `PluginContext<TConfig>` containing `config` and `capabilities`:

### 1. `callModel(modelName, prompt, options)`

Invokes an LLM endpoint configured in core (`config.models[modelName]`) via `src/llm/call.ts`.

- `prompt`: String or `{ system?: string; user: string }`.
- `options.timeoutSec`: Request timeout in seconds.
- `options.dumpId`: Optional debug dump identifier (e.g. `${chatId}.plugin`).

### 2. `http.route(route)`

Registers an HTTP route on the host's unified HTTP server (`node:http`):

- `route.method`: `'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | '*'`.
- `route.path`: Route pattern with optional parameter extraction (e.g. `/v1/games/:game/matches/:match_id`).
- `route.handler`: Receives `HttpRequest` with `headers`, parsed `params`, `rawBody` (Buffer), and parsed `body` (JSON if applicable). Returns `HttpResponse` (`status`, `headers`, `body`).
- Handlers run behind a body size limit (64 KB). Any thrown error is caught by the host and returned as HTTP 500 without leaking stack traces or internal secrets.

> **Path Preservation Notice for Reverse Proxies**: Protocols such as Tavern compute HMAC signatures over the exact request path (`timestamp.METHOD.path.rawBody`). When deploying behind a reverse proxy (e.g. Cloudflare Tunnel, Nginx, frp), the proxy **must pass the request path through without rewriting, stripping, or modifying prefixes**, otherwise signature verification will fail.

### 3. `chat.publish(chatId, options)`

The **only** authorized mechanism for a plugin to publish messages into a chat:

- `options.kind`: Optional event category (e.g. `'game_event'`).
- `options.text`: Sanitized public text to display in the group.
- `options.wake`: Whether this event should wake the Driver (`notifyDriver`).

**Identity & Gating**:
- The host automatically stamps the calling plugin's own ID (`plugin: pluginId`), preventing plugins from spoofing another plugin's identity.
- If the target `chatId` does not have `chats.<chatId>.plugins.<pluginId>.enabled: true`, the host drops the publication silently.

When allowed, the event is saved in the database as a generic runtime event (`kind: 'plugin_event'`) and rendered in context as:

```xml
<plugin-event plugin="tavern" t="10-22 20:30:00">Alice challenged Bob!</plugin-event>
```

### 4. `scene`

Enters, exits, or annotates contextual scenes contributed by the plugin:

- `ctx.capabilities.scene.enter(chatId, sceneId)`: Activates the scene `<pluginId>.<sceneId>` for the chat. Refreshes the scene's inactivity timeout (`idleTimeoutMs`, default 10 min).
- `ctx.capabilities.scene.exit(chatId, sceneId)`: Exits the scene manually for the chat.
- `ctx.capabilities.scene.note(chatId, sceneId, text | null)`: Sets or clears a private in-memory note for an active scene in this chat. Ignored if the scene is not active or the plugin is disabled for the chat. Automatically cleared on scene exit or idle expiry. Rendered strictly into the primary late-binding prompt.
- Inactivity timeouts are automatically refreshed whenever the plugin invokes `chat.publish(chatId, ...)` to that chat.

### 5. `storage`

Provides access to an isolated, writable filesystem directory for the plugin under the host's data volume:

- `ctx.capabilities.storage.rootDir`: Points to `<dataDir>/plugins/<pluginId>/` (ensured to exist).

### 6. `log`

Provides a scoped logger (`ctx.capabilities.log`) outputting under context `plugin:<pluginId>`.

### 7. `media.send(chatId, media)`

Interface stub for sending outbound media. In the current release, invoking this method throws a typed error (`media.send is unsupported`).

### 8. `ask(chatId, options)`

Additive capability for a plugin to ask the bot a targeted multiple-choice question "in character":

```ts
const { choice, reason } = await ctx.capabilities.ask(chatId, {
  question: '荷官邀请你上桌，要加入吗？',
  choices: ['接受', '拒绝'], // 2 to 5 choices
  timeoutMs: 8000,           // optional, capped at 14000
});
```

- **Execution Context**: Runs a single non-streaming model call. The system prompt is populated with the chat's persona (`systemFiles` content) and bot instructions. The user prompt contains a compact context block assembled entirely by core:
  - Current local time.
  - Participation signals (recent self messages in 10m, seconds since last message, consecutive bot exchanges).
  - The chat's `SELF.md` memory notes (if person memory is enabled for the chat).
  - The tail of rendered chatlog segments as XML (up to 30 segments).
  - The question and allowed choices.
- **Strict Isolation**: Plugins **never receive or inspect** this context block, chatlog, or memory notes; they receive solely `{ choice, reason }`.
- **Gating**: Rejected immediately if the plugin is not enabled for the target chat.
- **Model Resolution**: Uses `plugins.<id>.askModel` if configured in core, otherwise defaults to the chat's probe model.
- **Output & Cost Note**: The model is prompted to emit tiny JSON (`{"choice": "...", "reason": "..."}`). The choice is strictly validated against the allowed choices (exact match after trimming whitespace). If the model fails or times out, the call rejects; the plugin decides its own fallback. It is designed to be inexpensive (short context, tiny output tokens).

### 9. `isEnabledForChat(chatId)`

Helper available on both `ctx` and `ctx.capabilities` to check whether the plugin is enabled for a given chat:

```ts
const isEnabled = ctx.isEnabledForChat ? ctx.isEnabledForChat(chatId) : ctx.capabilities.isEnabledForChat?.(chatId);
```

---

## 4. Privacy Invariant

The privacy invariant is the most critical security boundary for plugins:

1. **Private State Isolation**: Private state (e.g. secret game hands, internal tokens, hidden session data) must reside solely in the plugin's in-memory state or local `storage`.
2. **Context Secrecy**: Private state must **never** enter:
   - Core projection or Intermediate Context (`IC`).
   - Rendered XML Context (`RC`).
   - SQLite `events` or `turn_responses` tables.
   - Long-term person memory.
   - Probe prompts.
   Private state may reach the model only via `scene.note`, which injects strictly into the primary late-binding prompt (in-memory only, never persisted).
3. **Public Events Only**: Plugins only push public, broadcast-safe text through `chat.publish`.
4. **Mandatory Testing**: Every plugin handling private data must include automated regression tests asserting that private data is never forwarded to `chat.publish`.

---

## 5. Configuration & Secrets

Configuration follows core deployment practices:

### Core Configuration (`config.yaml`)

```yaml
plugins:
  server:
    host: "0.0.0.0"
    port: 8787
  tavern:
    secret: "shared_hmac_secret"
    model: "probe"
    decisionTimeoutMs: 40000
    basePath: "/tavern"          # deployment prefix included in the signed path
    tableName: "LuckyBot"
    invitation:
      decide: "ask"              # "always" or "ask"
      timeoutMs: 8000            # capped at 14000 (host `ask` limit; dealer waits 30 s)
      onTimeout: "accept"
    games:
      liars_bar:
        enabled: true
        modes: ["classic", "devil", "chaos"]   # optional allowlist; omit for all
      bullet_poker:
        enabled: true

chats:
  default:
    plugins:
      tavern:
        enabled: false
  oc_example_group:
    plugins:
      tavern:
        enabled: true
```

- **Default-off**: Plugins are disabled globally and per chat by default.
- **Secrets redaction**: Plugin secrets in `config.yaml` are registered with `registerHttpSecret` so they are automatically redacted from error logs.
- **No secrets in repository**: Plugins must never hardcode credentials or commit sample secrets.

### Tavern plugin configuration

The tavern plugin serves the third-party dealer protocol (see `plugins/src/tavern/openapi.json`). Enable it per chat with `chats.<id>.plugins.tavern.enabled: true`; the top-level `plugins.tavern` block is the deployment configuration.

| Key | Default | Meaning |
|---|---|---|
| `secret` | required | Shared HMAC secret (not a Feishu secret). Requests are signed over `{timestamp}.{METHOD}.{path}.{raw body bytes}`; the path includes `basePath` and excludes the query string. |
| `model` | `"probe"` | Model used for game decisions and event table talk. |
| `askModel` | chat probe model | Model used by the invitation `ask` capability. |
| `decisionTimeoutMs` | `40000` | Our share of a decision deadline, capped at `58000`. The applied budget is `min(decisionTimeoutMs, deadline_ms - 3000)` with a floor of 1000 ms. |
| `invitation.decide` | `"always"` | `"always"` accepts every supported invitation; `"ask"` asks the bot in character. |
| `invitation.timeoutMs` | `8000` | Invitation decision timeout, capped at `14000` to match the host `ask` capability (the dealer itself waits 30 s). |
| `invitation.onTimeout` | `"accept"` | Fallback when `ask` fails or times out. |
| `basePath` | `""` | Path prefix (e.g. `/tavern`) mounted on the unified HTTP server and included in the signature. |
| `tableName` | `"LuckyBot"` | Display name used in table messages. |
| `games.<id>.enabled` | `true` | Per-game switch; `false` makes invitations return `accept: false` and rounds/decisions/events return 404. |
| `games.<id>.modes` | all modes | Optional allowlist (Liar's Bar: `classic` / `devil` / `chaos`); an invitation for another mode is declined. |

Games currently registered: `liars_bar` (骗子酒馆) and `bullet_poker` (子弹德州). Decisions prefer the dealer's generic `ask` / `prompt` / `rules` / `choices` fields and reply `{ "turn_id": …, "choice": "…" }`; the legacy per-game action path is used only when `choices` is absent. Duplicate deliveries are acknowledged with `200 {}` (duplicate decisions return the cached reply), and `seq` is not treated as a monotonic cursor because it restarts when the dealer restarts.

---

## 6. Extension Points

Declared in `plugin.contributes`:

| Extension Point | Status | Description |
|---|---|---|
| `httpRoutes` | Implemented | Static routes mounted on the core HTTP server. |
| `promptHints` | Implemented | `(chatId: string) => PromptHint[]` contributing system prompt instructions for chats where the plugin is enabled. |
| `tools` | Implemented | `PluginTool[] \| ((chatId: string, chatConfig?: unknown) => PluginTool[])` contributing primary LLM tools callable during the Driver's turn loop for enabled chats. |
| `scenes` | Implemented | `PluginSceneDefinition[]` contributing contextual scene definitions (`id`, `hint`, `idleTimeoutMs`) activated via `scene.enter`/`exit`. |
| `redactText` | Implemented | `(text: string) => string`, pure, synchronous, deterministic. Strips secrets from every text part core sends to a model. Global, not per chat; composed in registration order across active plugins. Additive, no `sdkVersion` bump. |
| `inspectText` | Implemented | `(text: string) => RedactionHit[]` (`{ kind, length, hash }`). Shadow companion of `redactText`: reports what would be removed without changing anything and never returns the matched text. |
| `memoryBackend` | Declared | Custom memory storage backend (e.g. Mem0). |
| `mediaResolvers` | Declared | Media frame/transcription resolvers (e.g. speech-to-text). |

### Background tools

Primary turns are bounded (15 s deadline, two tool rounds), so a slow tool must not hold the turn. A `PluginTool` can opt in with an additive `background` field (no `sdkVersion` bump):

```ts
{
  name: 'web_fetch',
  // ...
  background: { afterMs: 4000, timeoutMs: 60_000 },
  execute: async (input, signal) => { /* signal is optional to honour */ },
}
```

- If `execute` settles within `afterMs`, the result is returned inline, exactly like a tool without the field. A throw is reported as an ordinary tool error.
- Otherwise the host moves the still-running call into a `plugin_tool` background task bounded by `timeoutMs` and returns `{ "background_task_id": N, "message": "..." }` to the model with `requiresFollowUp: false`. The model may say it is checking and end the turn; the turn does not wait.
- When the call settles, the task completes and a `<runtime-event type="task-completed" task-type="plugin_tool">` wakes the chat. Its summary is the tool's result content itself (cut at 4000 characters with a truncation note; the full text stays available to `read_task_output`). A rejection becomes a `Tool ... failed: <message>` summary instead of an exception.
- On `timeoutMs` (or `kill_task`), the task completes with a timeout/cancel summary, the plugin's `AbortSignal` (second `execute` argument, passed only for tools that declare `background`) is aborted, and the promise is abandoned. Ignoring the signal is allowed; a late result is discarded.
- A restart cannot resume an in-flight promise: the recovered task completes at once with "interrupted: runtime restarted".
- The task belongs to the chat that made the call and counts as one work-tool call under the turn budget. The plugin never touches the task manager; the host passes it a narrow closure only.
- There is no `sleep` tool. Background completions wake the bot, so waiting is never needed.

### Cron plugin

The `cron` plugin (`plugins/src/cron/`) lets the bot schedule its own future wake-ups.

**Who decides.** Only the bot, through its own tools. There is no HTTP route, chat command or maintainer override that creates, edits or forces a schedule; a deployment can only switch the plugin off per chat. A request in chat ("莱克明早8点提醒我…") is a suggestion: the bot weighs it, a message marked `maintainer="true"` somewhat more, and may decline. The prompt hint says exactly that (it never tells the bot to ignore people).

**Tools** (contributed per chat, so each is bound to its chat; the plugin never sees chat context):

| Tool | Meaning |
|---|---|
| `schedule_wakeup({ at? , cron?, note, reason? })` | Exactly one of `at` (`YYYY-MM-DD HH:MM`) or `cron` (5 fields). Local time, the same clock as chatlog timestamps. `note` (≤300 chars) is written by the bot and lands in the chat context, so it must be broadcast-safe. `reason` (≤200 chars) goes only to the audit file. Returns `{ id, kind, next_fire, note }`. |
| `list_schedules()` | Active items of this chat with id, next fire time and note. |
| `cancel_schedule({ id })` | Cancels one item of this chat. |

Limit violations come back as `{ "error": "…" }` tool results, not exceptions.

**Configuration** (`plugins.cron`, all optional; presence of the block loads the plugin, `chats.<id>.plugins.cron.enabled: true` enables it per chat):

| Key | Default | Meaning |
|---|---|---|
| `maxActivePerChat` | `20` | Active schedules per chat. |
| `maxHorizonDays` | `60` | First fire must lie within this many days (and at least 1 minute ahead). |
| `minRecurringIntervalMin` | `60` | A cron expression may not fire more often; checked by scanning its occurrences over a year. |
| `lateGraceHours` | `6` | An overdue one-shot older than this is dropped (logged) instead of fired. |

**Cron syntax.** Exactly five fields (minute hour day-of-month month day-of-week), parsed by [`croner`](https://github.com/Hexagon/croner) in `legacyMode` (Vixie-style OR between day-of-month and day-of-week when both are restricted; a bare `*` counts as unrestricted, `*/n` does not). Six-field (seconds) and `@daily`-style forms are rejected. Local `Date` arithmetic is used throughout: a wall-clock time that does not exist (DST gap) never matches, and a repeated hour fires once.

**Storage.** `<storage.rootDir>/<chatId>.json` (`{ version: 1, items }`), one file per chat. The chat id is validated against `^[A-Za-z0-9_-]{1,64}$` before any path is built. Writes are atomic (tmp + rename). An unreadable or invalid file is logged at `error` and left untouched; that chat's tools fail until it is fixed. Items: `id`, `kind` (`once` | `cron`), `spec`, `note`, `reason`, `createdAtMs`, `nextFireAtMs`, `lastFiredAtMs`.

**Firing.** One `setTimeout` (unref'd, at most 1 h ahead, re-armed) targets the earliest due item of an enabled chat. A fire is `chat.publish(chatId, { kind: 'cron', text, wake: true })`: a `<plugin-event plugin="cron">` line that wakes the chat and goes through probe like any runtime event, so the bot may still stay silent. The text says it is the bot's own scheduled wake-up, repeats the note and, when late, by how much. Chats where the plugin is disabled are skipped and their items kept. One-shots are deleted and recurring items advanced after publishing (a crash in between repeats a reminder rather than losing it). A failed publish keeps the item and retries after 60 s.

**Startup catch-up.** Catch-up fires start 5 s after `setup` so core can finish seeding context. Overdue one-shots within `lateGraceHours` fire once with a "late" note; older ones are dropped with a warning. Recurring items whose occurrence is more than 2 minutes overdue skip every missed occurrence and move to the next future one (no burst).

**Prompt hints.** The plugin contributes one `system` hint. Core renders plugin hints in the primary system prompt only; the probe prompt carries none, so the probe learns that a fire is the bot's own earlier decision from the event text itself.

### Redact plugin

The `redact` plugin (`plugins/src/redact/`) keeps credentials out of model-bound traffic. Presence of `plugins.redact` loads it; the switch is `mode`, and there is no per-chat setting.

| `mode` | Behaviour |
|---|---|
| `off` (default) | Nothing is removed or logged; requests are byte-identical to a build without the plugin, and no prompt hint is rendered. |
| `shadow` | Requests are untouched. Per request, `callLlm` logs at `debug` the counts by kind and, for each hit (first 100), its kind, length and an 8-hex SHA-256 prefix. The matched text is never logged. |
| `enforce` | Matches are replaced by `[redacted:<kind>]`, irreversibly, with no placeholder map. A system prompt hint tells the model the marker means a removed secret that cannot be recovered and that people should not be asked to re-post it. |

`plugins.redact` is a strict object: the former `enabled` key (and any other key) fails startup validation instead of being ignored. `enabled: false` still skips the plugin like every plugin.

**Where it applies.** `src/llm/call.ts` is the one place all model calls share (primary, probe, compaction, memory consolidation, media alt text, plugin `callModel`/`ask`). Before wire conversion it applies the composed `redactText` to the system prompt, user/system/assistant text, text groups, tool-call arguments (the string leaves and keys of the JSON, so arguments stay valid JSON) and tool results; the `/tmp/cahciua/` request dump is built from the converted request, so it is redacted too. Not touched: images, reasoning blocks (Anthropic signatures, OpenAI encrypted content), tool schemas and descriptions, and everything persisted — events, turn responses and the database keep the original. The host installs the composed function into a process-wide slot (`installLlmRedactor` in `src/llm/redaction.ts`) on `start()` and clears it on `stop()`; nothing else writes it. With the slot empty or the function a no-op, `callLlm` passes the same objects through.

**Rules.** Ported from [magpie](https://github.com/yetone/magpie) (`internal/redact/`, MIT, copyright yetone; see `plugins/NOTICE`) into linear-time JS regexes plus two scanners (PEM blocks, BIP39 runs), with magpie's test cases: vendor keys and tokens (OpenAI, Anthropic, GitHub, GitLab, Slack, AWS, Google, Stripe, Telegram bot, npm, Hugging Face, JWT) → `api-key`/`token`; PEM/SSH private-key blocks and marked raw wallet keys → `private-key`; URL and connection-string passwords and password assignments → `password` (scheme and host kept); other secret assignments and `Authorization`-style header values → `secret` (key kept, value replaced); BIP39 seed phrases → `seed-phrase`; Luhn-valid 13–19 digit cards → `bank-card`; checksum-valid 18-character resident IDs → `cn-id`. There is no generic high-entropy rule.

**Protected spans.** Before the rules run, spans that must never change are marked, and any match overlapping one is dropped: Feishu `ou_`/`on_`/`oc_`/`om_` ids, `file_v…`/`img_v…` keys, rendered message aliases (`m` + 9 base36), UUIDs, 40-hex git SHAs, and every attribute value inside the rendered chatlog tags (`<message>`, `<mention>`, `<in-reply-to>`, attachments, events, …). Consequence: a UUID or 40-hex value assigned to a secret-named key is left alone.

**Audit before enforcing.** `pnpm redact:audit -- --db <path> [--limit N]` opens the SQLite database read-only (`readonly`, `query_only`), runs the rules over `events.text` and prints counts by kind plus, per hit, the event id, kind, length and a masked preview (first and last 2 characters, the rest `*`). `--limit N` scans the newest N events. It never writes.

---

## 7. Scenes & Context Overrides

Plugins declare scenes via `contributes.scenes: [{ id: 'table', hint: '...', idleTimeoutMs: 600000 }]`.
Scenes are entered and exited by the plugin using `ctx.capabilities.scene.enter(chatId, sceneId)` and `exit(chatId, sceneId)`.
State is held in-memory per chat by the host.

While a scene is active for a chat:
1. **Scene profile merge**: The Driver applies the scene profile configured under `chats.<id>.scenes.<pluginId>.<sceneId>`, merged over chat config for that wake-up only:
   ```yaml
   chats:
     <id>:
       scenes:
         tavern.table:          # <pluginId>.<sceneId>
           hint: "…"            # late-binding prompt instruction
           participation: { botRounds: 2, brakeMessages10m: 12 }
           primary: { extraBody: { reasoning_effort: low } }
   ```
2. **Strict validation**: Only `hint`, `participation`, and `primary.extraBody` are accepted in v1. Unknown keys (including model switching) are rejected to preserve prefix prompt caching.
3. **Late-binding hint**: The scene's default hint comes from the plugin; config overrides it. The hint is appended only to the primary late-binding prompt, keeping probe prompts unaffected and prompt prefixes cache-safe.
4. **Inactivity timeout**: If no new `chat.publish` occurs from that plugin to that chat within `idleTimeoutMs` (default 10 minutes), the scene automatically expires.

---

## 8. Web Plugin & Configuration Migration

Web search (`web_search`) and web fetch (`web_fetch`) are provided by the `web` plugin (`plugins/src/web/`).

Both tools declare `background: { afterMs: 4000, timeoutMs: 60000 }` (see Background tools). Override globally with `plugins.web.background: { afterMs, timeoutMs }`.

### Migration from Legacy Core Web Config

The legacy keys `tools.web.providers` and `chats.<id>.tools.webSearch/webFetch` have been removed from core.
Configuration is migrated to `plugins.web` and `chats.<id>.plugins.web`:

**Before (legacy):**
```yaml
chats:
  default:
    tools:
      web:
        providers:
          tavily: { apiKey: "tvly-..." }
        search: "tavily"
        fetch: "jina"
```

**After (plugins):**
```yaml
plugins:
  web:
    providers:
      tavily: { apiKey: "tvly-..." }
    search: "tavily"
    fetch: "jina"

chats:
  default:
    plugins:
      web:
        enabled: true
```

---

## 7. Lifecycle Order

1. **Process Start**: Container is built; database migrated; platform identity prepared.
2. **Plugin Host Initialization**: `PluginHost` resolves registered plugins, verifies `sdkVersion`, and validates configs.
3. **Driver Activation**: Driver is attached and input bus activated.
4. **Plugin Startup**:
   - `PluginHost.start()` starts the unified HTTP server if routes exist.
   - `plugin.setup(ctx)` is invoked for every enabled plugin.
5. **Process Shutdown**:
   - `PluginHost.stop()` is executed **first**: `plugin.stop?()` is called on each plugin, followed by closing the HTTP server.
   - Driver and background tasks shut down.
   - Platform clients stop.
   - Database closes and container disposes.

---

## 8. Step-by-Step: Adding a New Plugin

1. In `plugins/src/`: create directory for your plugin (e.g. `src/my-plugin/`).
2. Implement your plugin using `definePlugin`:
   - Set `sdkVersion: CURRENT_SDK_VERSION`.
   - Provide a Valibot `configSchema`.
   - Register routes via `ctx.capabilities.http.route` or `contributes.httpRoutes`.
   - Publish public chat events via `ctx.capabilities.chat.publish`.
3. Export your plugin in `plugins/src/index.ts`.
4. Add unit tests verifying:
   - Correct functionality under mocked capabilities.
   - Complete enforcement of the privacy invariant.
5. Configure `config.yaml`:
   - Add configuration under `plugins.<id>`.
   - Enable the plugin for desired chats under `chats.<chatId>.plugins.<id>.enabled: true`.

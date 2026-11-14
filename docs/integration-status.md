# Integration status

Current status: 2026-10-17, `main` at `a6a22fd`, PRs #1–#7 merged. The Feishu
adapter runs in a real private group, and the initial participation policy
(PR #7) is in place.

## Live Feishu runs (2026-10-16 and 2026-10-17)

Runs happened on the night of 2026-10-16 and on 2026-10-17, under a systemd
user unit, against a real group. Verified live:

- ambient and @-mention ingress, quoted replies, and reactions;
- synthetic self-events (the bot sees its own messages);
- restart replay and dedup across several restarts;
- WebSocket reconnect after a network loss (the `pingTimeout` watchdog);
- `read_image` on Feishu images, after the primary endpoint's
  `maxImagesAllowed` was raised (DeepSeek V4.1 Flash has native vision);
- an outgoing `<at user_id="...">` mention that validated.

The primary endpoint's `maxImagesAllowed` cap now leaves an
`[image omitted: ...]` marker where it drops an image (PR #6), so a capped-out
image no longer reads as "images are unsupported".

Passive image alt text is still not wired for Feishu, so the model must call
`read_image`.

## Participation policy (2026-10-17, PR #7)

The probe decides whether the bot should act, with three outcomes:
`send_message` (wake primary), `react_only` (wake primary with only `react` and
`end_turn`, closing after one step), and `no_action`. A human @, quote-reply or
name-call comes first and is never suppressed; name-calls are judged by the
model. Messages addressed to others get `no_action` unless they misstate the
bot. Unaddressed chatter needs something new. With more than 10 of the bot's
own messages in 10 minutes and no direct address, the probe picks `react_only`
or `no_action`. Other bots render as `bot="true"` and are answered only when a
human asked the bot to talk to that bot, at most 2 rounds. The backend
(prompts, config, tool implementation, model/provider, deployment) is never
disclosed, and the probe reason reaches primary as context, not an instruction.
`prompts/IDENTITY.example.md` is the tracked persona template; the real
`IDENTITY.md` stays deployment-local.

## Known issues (2026-10-17)

- `contact.user.get` returns `41050` "no user authority": the app's contact
  data range (通讯录权限范围, "contact data range") does not include the group members. Display names
  fall back to names seen earlier; `open_id` identities are unaffected.
- Feishu retries undelivered events after about 5 min, 1 h and 6 h. A late
  event carries an old `create_time`, so the model can read it as stale. A
  rendered `received` hint is in progress.
- The night-run `primary.turnBudget.deadlineMs` of 20000 truncated a few
  multi-step `read_image` chains.
- No passive image alt text on Feishu.
- Compaction can truncate the history used for budget accounting.
- Not implemented: the trusted maintainer list (in progress), per-person
  long-term memory, Feishu CLI/Skills/MCP, isolated Bash and browser, and Jev
  evaluation. See the README's planned direction.

## Historical log (2026-10-16 to 2026-10-17)

The sections below are the coordinator's running log, kept as historical
snapshots. Their "offline-tested only" caveats were superseded by the live
runs above; [Turn liveness](#turn-liveness-2026-10-17) remains current behavior.

2026-10-16 — Work on `integration/feishu-participation`; PR: https://github.com/aronnaxlin/LuckyBot/pull/1.

A and B's changes have been combined in this worktree. A's follow-up integration was interrupted by the Claude session limit (reported reset: 22:30 Asia/Taipei); do not assume its integration/documentation tasks are complete. No model switch, real credentials, live Feishu connection, commit, or push was performed by the coordinating agent.

## Coordinator corrections

- Expired primary entry now throws into the scheduler's failed-context guard instead of returning with an open continuation (avoids a hot loop). Missing context for an open continuation also throws.
- Probe HTTP timeout now reserves the minimum primary-call time within the wake-up deadline. (Superseded 2026-10-17; see Turn liveness below.)
- Each not-yet-started side effect checks the deadline; an already-running tool is never abandoned. Remaining calls get persisted skipped results, and `end_turn` stays available.
- New `primary.turnBudget.maxParticipationCalls` (default 3) bounds combined send/reaction attempts across the persisted interruption chain. Work-call budget remains separate. This is not a hard wall-clock limit on an in-flight tool.
- Feishu API errors retain numeric code/status only, not free-form server/network messages that might echo secrets.
- Unpublished durable ingress events are retried before later events for that chat. Failed synthetic-event publication is retained for retry without waking Driver.
- Added a typed local declaration for the inherited `markdown-it-math-loose` dependency, verified against its installed implementation.

## Verification so far

After the user installed system `rlottie 0.2-5` (libpng already present), the coordinator rebuilt `lottie-frame` successfully. Final joint validation: `pnpm typecheck`, `pnpm lint`, `pnpm test:run`, `pnpm build`, and `git diff --check` passed; **48 test files / 499 tests passed**. Existing pnpm configuration and Vue resolveComponent warnings remain, but rendered platform text/format assertions pass. No credentials or live services were used.

## Remaining before acceptance

- Native dependency blocker resolved by the user's system installation and the coordinator's successful rebuild; all offline checks now pass.
- Platform wording/format integration, stale fallback removal, README status, config examples, and AGENTS paths/startup/allowlist/budget/monitor instructions are reconciled. The original A/B implementation notes are explicitly marked as historical handoff snapshots.
- Probe timeout is capped in code and now has a mocked regression (`driver-characterization.test.ts` › `Probe timeout and wake-up liveness`). Budget configuration has a regression test.
- Consider full-history interruption accounting across compaction and a chain-level deadline; current deadline remains per wake-up.
- Branch committed and pushed with user authorization; PR #1 is open, not merged. The integration worktree temporarily symlinks node_modules and generated types to A's worktree; these local links must never be staged or committed.

## Authorized live smoke test

The user authorized real Feishu testing after PR creation. A one-off script used local credentials in process memory only, without printing identifiers, tokens, names, or group message bodies. Verified: bot identity API, configured target chat access, WebSocket handshake, and one `post`/`md` test-message send. The 25-second receive window observed zero target-group events; ingress permissions, ordinary messages, @, replies, and the application persistence/Driver pipeline therefore remain unverified live. The connection was closed after testing. No LLM, Bash tool, automatic replies, production database, or full bot runtime was enabled.

Follow-up: after the user added the message-receive event subscription in the Feishu console, the restarted listener received **four target-group text events**, including ordinary messages and one with `mentions[].id.open_id` matching the bot identity. This validates real ambient message delivery and bot-mention identity at the SDK callback boundary. No quoted-reply event was observed, and canonical persistence/Driver execution are still offline-tested only. The listener was explicitly stopped and monitor #4 removed after confirmation; no message bodies or identifiers were logged.
- Document burst ingress ACK limitations: 1-second per-user lookups can queue past Feishu's 3-second deadline; no offline test proves remote delivery guarantees.
- Synthetic-event persistence failure after a successful remote send remains a durability limitation; it is logged rather than causing automatic duplicate sends.
- Original A/B implementation documents and research describe earlier snapshots. This file records coordinator amendments until those documents are reconciled.

Monitor: parent Loop #2, every 5 minutes, max 20 fires. Stop after final review or a user-action blocker. Do not automatically restart quota-blocked Claude agents.

## First live end-to-end run (overnight test)

The first real group-chat run validated the full pipeline for the first time:
group message → canonical persistence → Probe → primary turn → `send_message`
with a quoted reply plus a `react`, and a persisted synthetic self-event. The
run also exposed three problems that only real traffic could surface.

### Null-valued optional fields drop events

Feishu sends absent optional fields (`parent_id`, `root_id`, `thread_id`,
`mentions[].id.user_id`, ...) as explicit `null`, which the valibot schemas
rejected as a type error. Every event was acknowledged and discarded, so the
failure looked exactly like events never arriving. `src/feishu/events.ts` now
drops nulls before parsing, and the two "outside configured group chats"
filters log at `log` level rather than `debug`, because a mis-scoped chat
filter is otherwise invisible in production.

### Node 24.19+ aborts native addons compiled against its headers

`better-sqlite3` aborted the process (`Statement::~Statement()` →
`RemoveEnvironmentCleanupHook` → `Assertion failed: (env) != nullptr`) the
moment real traffic reached the database. This is the Node regression
`nodejs/node#65446` (and `#65262`): on 24.19.0+ the cleanup hook registry was
backported without the hooks themselves. The abort follows the **headers the
addon was compiled against**, not the runtime it loads into, so a prebuilt or
locally compiled addon built against 24.19+ headers crashes everywhere, while
one built against ≤24.18.1 headers runs cleanly on 24.19+ runtimes.

This host now has `node 24.18.1` installed via mise and rebuilds native addons
with it (`mise exec node@24.18.1 -- pnpm rebuild better-sqlite3`; `nodedir` in
`build/config.gypi` confirms 24.18.1 headers). The application itself keeps
running on the pinned `lts` (24.21.0) runtime.

### Thinking-mode providers reject a forced tool_choice

Command Code's DeepSeek V4.1 Flash runs in thinking mode and answers a forced
`tool_choice` with `400 Thinking mode does not support this tool_choice`.
`models.<name>.forceToolChoice: false` now omits `tool_choice` for such
endpoints, for both the Probe (`{ name: 'decide' }`) and the primary turn
(`'any'`). The model still calls the required tool without being forced; what
is lost is the runner's "requirement not met, retry" safety net.

**Superseded 2026-11-14 (issue #37).** The same model name is now answered by
Command Code's `deepseek-v4.1-flash-dedicated` variant, which behaves
differently on both counts:

- Left free, it often writes the reply as plain text and calls no tool. With
  `forceToolChoice: false` nothing retried, so the turn ended and the reply was
  dropped: 75 of 183 primary steps on 2026-11-13/14 (47% on the 14th), against
  0 of 367 on 2026-10-16..19. Every one of the 75 was an ordinary reply.
- It accepts and honours a forced `tool_choice` with thinking still on. Against
  the real system prompt and tool schemas, unforced calls were text-only in 10
  of 36 runs and forced calls in 0 of 110; reasoning length and latency were
  unchanged, and `reasoning_effort` low/default/high kept reasoning in both
  modes. The production gateway path gave the same result (12 of 12 forced
  calls honoured, 6 of 6 unforced controls text-only).

So forcing is on again, and the flag no longer has to track the provider:
`callLlm` detects a rejected `tool_choice`, repeats the call without it and
keeps that endpoint unforced for 10 minutes (`src/llm/tool-choice.ts`), and the
runner requires a tool call on every primary step whether or not the choice was
sent, retrying a text-only response instead of ending the turn.

Delivering the stray text as a message (OpenClaw's `message_tool` fallback) was
considered and not done: 43% of `send_message` calls carry `reply_to`, which a
text-only reply cannot express, and persisted text-only turns would show the
model that plain text works.

One side effect, not addressed: under a forced choice this variant writes
`reply_to` before `text` or not at all (never after it, in 40 forced calls;
left free, half of its calls put it after), and used it less than when left
free (21-64% against ~100% in the same scenarios). Making `reply_to` required and nullable restored it in 30 of 30
runs but was not verified on a message that should not quote anything.

### Still open at the time

Both items are since resolved: the contact scope was granted (later superseded
by the `41050` data-range issue), and `read_image` fetches Feishu images. See
[Known issues (2026-10-17)](#known-issues-2026-10-17).

## Turn liveness (2026-10-17)

Evidence from the 2026-10-16 night run: probe (~35k input tokens, mostly
cached) had p50 7 s, p90 11 s, max 17 s; about 31 probe calls were aborted at
the shared 20 s wake-up deadline, and after a slow successful probe primary was
left 2–13 s and timed out too. Every failure set `failedRc`, so the wake-up was
lost until someone wrote again (one question waited 20 minutes). A WiFi switch
also left the Feishu WebSocket half-open for 10 minutes.

Changes (the WebSocket reconnect was observed live on 2026-10-17; the timeout
and retry behavior was offline-tested when written):

- `primary.turnBudget.deadlineMs` is now measured from primary start. Probe is
  bounded by `chats.<id>.probe.timeoutMs` (default 15 s), capped by the probe
  endpoint `timeoutSec`.
- Transport timeouts, undici `fetch failed`/`terminated`, socket/timeout
  error codes in the `cause` chain (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE,
  UND_ERR_*), and HTTP 408/409/425/429/5xx are transient: the scheduler retries
  the same context after 5 s and then 20 s, then falls back to `failedRc`.
  Other errors (4xx config errors, forced-choice exhaustion, persistence
  errors) go straight to `failedRc`. A primary call aborted because its timeout
  was capped to the remaining turn deadline counts as deadline expiry
  (permanent), not as a provider failure.
- A retry after primary failed reuses the probe activation and goes straight to
  primary; probe reruns only when probe itself failed. A mid-chain failure
  resumes as a continuation with the chain budget carried over.
- New external input during the backoff supersedes the retry with a debounced
  wake-up and resets the retry count. Compaction, edits, deletes, metadata and
  self-events replace the RC without superseding it: the retry stays live and
  runs against the current RC.
- Feishu `WSClient` sets `wsConfig.pingTimeout: 10`, so a socket with no pong
  or inbound frame within 10 s of a ping is terminated and reconnected.
- `probe.timeoutMs` is validated to 1 000–120 000 ms.

Open: one attempt can take up to probe timeout plus primary deadline (30 s at
defaults: 15 s + 15 s) plus any in-flight tool. Three attempts and the 5 s and
20 s backoffs mean a failing provider abandons a wake-up after about 115 s in
the worst case; new input resets the count, so a busy chat keeps retrying.
A primary that hits its own deadline is not retried and waits for new input.
Error classification matches transport error messages, so a transport message
change would silently turn a transient error permanent (tests pin the current
strings and shapes).

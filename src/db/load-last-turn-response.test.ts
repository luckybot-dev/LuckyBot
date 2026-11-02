import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { codec } from './codec';
import { loadLastTurnResponse, loadTurnResponses } from './persistence';
import * as schema from './schema';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));

const entriesFor = (text: string) => [
  { kind: 'message', role: 'user', parts: [{ kind: 'text', text }] },
];

const fixture = () => {
  const sqlite = new Database(':memory:');
  opened.push(sqlite);
  sqlite.exec(`CREATE TABLE turn_responses_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    entries TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    model_name TEXT NOT NULL DEFAULT '',
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    shell_tools_exposed INTEGER NOT NULL DEFAULT 0
  )`);
  const db = drizzle(sqlite, { schema });
  const insert = sqlite.prepare(
    'INSERT INTO turn_responses_v2 (chat_id,requested_at,entries) VALUES (?,?,?)',
  );
  // Rows are stored through the same codec the runtime uses, so the test
  // exercises real decoding rather than a hand-built JSON shape.
  const seed = async (chatId: string, requestedAt: number, text: string) => {
    insert.run(chatId, requestedAt, await codec.stringify(entriesFor(text)));
  };
  return { db, seed };
};

describe('loadLastTurnResponse', () => {
  it('returns only the newest row, not the whole history', async () => {
    const { db, seed } = fixture();
    // A long-lived chat: many rows, only the last one matters to startup.
    for (let i = 1; i <= 200; i++) await seed('chat', i, `m${i}`);

    const all = await loadTurnResponses(db, 'chat');
    const last = await loadLastTurnResponse(db, 'chat');

    expect(all).toHaveLength(200);
    expect(last?.requestedAtMs).toBe(200);
    // The decoded payload must match the full load's tail, so callers that
    // inspect entries (the open-continuation check) see identical data.
    expect(last?.entries).toEqual(all.at(-1)!.entries);
  });

  it('breaks a requestedAt tie by id, matching loadTurnResponses order', async () => {
    const { db, seed } = fixture();
    await seed('chat', 100, 'first');
    await seed('chat', 100, 'second');

    const all = await loadTurnResponses(db, 'chat');
    const last = await loadLastTurnResponse(db, 'chat');

    expect(last?.entries).toEqual(all.at(-1)!.entries);
  });

  it('scopes by chat and returns null for an empty chat', async () => {
    const { db, seed } = fixture();
    await seed('chat', 1, 'a');
    await seed('other', 2, 'b');

    expect((await loadLastTurnResponse(db, 'chat'))?.requestedAtMs).toBe(1);
    expect((await loadLastTurnResponse(db, 'other'))?.requestedAtMs).toBe(2);
    expect(await loadLastTurnResponse(db, 'missing')).toBeNull();
  });

  it('carries the fields the open-continuation check reads', async () => {
    const { db, seed } = fixture();
    await seed('chat', 1, 'a');

    const last = await loadLastTurnResponse(db, 'chat');

    // wasToolLoopInterrupted touches `entries`; the runner also needs the
    // model/token/shell fields, so a partial row would silently misbehave.
    expect(last).toMatchObject({
      requestedAtMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      modelName: '',
      shellToolsExposed: false,
    });
    expect(Array.isArray(last?.entries)).toBe(true);
  });
});

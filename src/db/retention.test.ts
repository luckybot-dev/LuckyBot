import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { codec } from './codec';
import { loadLastProbeTime, loadTurnResponses } from './persistence';
import { pruneHistory, vacuumIfNeeded } from './retention';
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
  sqlite.exec(`CREATE TABLE probe_responses_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    entries TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    model_name TEXT NOT NULL DEFAULT '',
    is_activated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0
  )`);
  const db = drizzle(sqlite, { schema });
  const insertTurn = sqlite.prepare(
    'INSERT INTO turn_responses_v2 (chat_id,requested_at,entries) VALUES (?,?,?)',
  );
  const insertProbe = sqlite.prepare(
    'INSERT INTO probe_responses_v2 (chat_id,requested_at,entries) VALUES (?,?,?)',
  );
  const seedTurn = async (chatId: string, at: number, text: string) =>
    insertTurn.run(chatId, at, await codec.stringify(entriesFor(text)));
  const seedProbe = async (chatId: string, at: number, text: string) =>
    insertProbe.run(chatId, at, await codec.stringify(entriesFor(text)));
  return { db, seedTurn, seedProbe };
};

describe('pruneHistory', () => {
  it('deletes only rows older than the cutoff, per chat', async () => {
    const { db, seedTurn, seedProbe } = fixture();
    for (const at of [100, 200, 300]) await seedTurn('chat', at, `t${at}`);
    await seedTurn('other', 100, 'o100');
    for (const at of [100, 200]) await seedProbe('chat', at, `p${at}`);

    const removed = pruneHistory(db, 'chat', {
      turnResponsesBeforeMs: 250,
      probeResponsesBeforeMs: 150,
    });

    expect(removed).toEqual({ turnResponses: 2, probeResponses: 1 });
    // The surviving turn is the newest one; the other chat is untouched.
    expect((await loadTurnResponses(db, 'chat')).map(t => t.requestedAtMs)).toEqual([300]);
    expect((await loadTurnResponses(db, 'other')).map(t => t.requestedAtMs)).toEqual([100]);
    expect(loadLastProbeTime(db, 'chat')).toBe(200);
  });

  it('keeps everything when a cutoff is absent or non-positive', async () => {
    const { db, seedTurn, seedProbe } = fixture();
    await seedTurn('chat', 100, 'a');
    await seedProbe('chat', 100, 'b');

    expect(pruneHistory(db, 'chat', {})).toEqual({ turnResponses: 0, probeResponses: 0 });
    expect(pruneHistory(db, 'chat', { turnResponsesBeforeMs: 0, probeResponsesBeforeMs: 0 }))
      .toEqual({ turnResponses: 0, probeResponses: 0 });
    expect(await loadTurnResponses(db, 'chat')).toHaveLength(1);
  });

  // The cursor floor is the whole safety argument for trimming turn responses:
  // anything at or after the compaction cursor is still live context. The
  // startup caller raises the age cutoff to `max(ageCutoff, cursor)`, so the
  // prune itself must treat `beforeMs` as exclusive.
  it('keeps rows at the cutoff, so a cursor passed as the cutoff is never eaten', async () => {
    const { db, seedTurn } = fixture();
    for (const at of [100, 200, 300, 400]) await seedTurn('chat', at, `t${at}`);

    const { turnResponses } = pruneHistory(db, 'chat', { turnResponsesBeforeMs: 300 });

    expect(turnResponses).toBe(2);
    expect((await loadTurnResponses(db, 'chat')).map(t => t.requestedAtMs)).toEqual([300, 400]);
  });
});

describe('vacuumIfNeeded', () => {
  it('skips when the free-page share is below the threshold', async () => {
    const { db, seedTurn } = fixture();
    for (let i = 1; i <= 50; i++) await seedTurn('chat', i, `t${i}`);
    // A fresh database with no deletes has no freelist pages at all.
    expect(vacuumIfNeeded(db, 0.25)).toBe(false);
  });

  it('runs once enough pages are free, and the table survives it', async () => {
    const { db, seedTurn } = fixture();
    for (let i = 1; i <= 200; i++) await seedTurn('chat', i, `t${i}`);
    pruneHistory(db, 'chat', { turnResponsesBeforeMs: 199 });

    const ran = vacuumIfNeeded(db, 0.01);
    expect(ran).toBe(true);
    expect((await loadTurnResponses(db, 'chat')).map(t => t.requestedAtMs)).toEqual([199, 200]);
  });
});

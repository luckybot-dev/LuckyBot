/**
 * Read-only audit of the redact plugin's rules against archived chat text.
 *
 * Usage: pnpm redact:audit -- --db <path to sqlite> [--limit N]
 *
 * Runs the rules over `events.text` (newest N events with --limit, else all)
 * and prints counts by kind plus, per hit, the event id, kind, length and a
 * masked preview (first and last two characters). The database is opened
 * read-only with `query_only` on; nothing is ever written. Use it to spot false
 * positives before switching `plugins.redact.mode` to `enforce`.
 */
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import { auditRows, formatReport, type AuditRow } from '../src/plugins/redact-audit';

const main = (): void => {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(a => a !== '--'),
    options: {
      db: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  if (!values.db) throw new Error('Usage: pnpm redact:audit -- --db <path> [--limit N]');
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }

  const db = new Database(values.db, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const sql = `SELECT id, text FROM events WHERE text IS NOT NULL AND text != ''${limit ? ' ORDER BY id DESC LIMIT ?' : ' ORDER BY id'}`;
    const stmt = db.prepare<unknown[], AuditRow>(sql);
    const rows = limit ? stmt.iterate(limit) : stmt.iterate();
    console.log(formatReport(auditRows(rows)));
  } finally {
    db.close();
  }
};

main();

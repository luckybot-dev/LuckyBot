import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { auditRows, formatReport, maskPreview } from './redact-audit';

// Split so secret scanners do not flag the fixture.
const KEY = 'ghp_' + 'Ab3dE5gH7jK9mN1pQ3sT5vX7zB2cD4fG6hJ8';

describe('maskPreview', () => {
  it('keeps the first and last two characters', () => {
    expect(maskPreview('abcdefgh')).toBe('ab****gh');
    expect(maskPreview(KEY)).toBe(`gh${'*'.repeat(KEY.length - 4)}J8`);
  });

  it('masks short values completely and counts code points', () => {
    expect(maskPreview('abcd')).toBe('****');
    expect(maskPreview('密码是秘密')).toBe('密码*秘密');
  });

  it('caps the run of stars for long matches', () => {
    expect(maskPreview('x'.repeat(5000))).toBe(`xx${'*'.repeat(36)}xx`);
  });
});

describe('auditRows', () => {
  it('counts by kind and reports event id, kind, length and a masked preview', () => {
    const report = auditRows([
      { id: 1, text: 'hello world' },
      { id: 2, text: `key ${KEY}` },
      { id: 3, text: null },
      { id: 4, text: 'card 4111111111111111 and password=hunter2pass99' },
      { id: 5, text: '<message id="m4f8a2c01" uid="ou_4111111111111111">hi</message>' },
    ]);
    expect(report.scanned).toBe(5);
    expect(report.withText).toBe(4);
    expect(report.counts).toEqual({ 'api-key': 1, 'bank-card': 1, secret: 1 });
    expect(report.hits.map(h => [h.eventId, h.kind])).toEqual([[2, 'api-key'], [4, 'bank-card'], [4, 'secret']]);
    expect(report.hits[1]).toMatchObject({ length: 16, preview: '41************11' });
    const out = formatReport(report);
    expect(out).toContain('4 with text, 3 hits');
    expect(out).toContain('event 2\tapi-key\tlen=40\tgh');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('hunter2pass99');
  });
});

describe('read-only database access', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a readonly connection can feed the audit and cannot write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redact-audit-'));
    dirs.push(dir);
    const path = join(dir, 'a.db');
    const rw = new Database(path);
    rw.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, text TEXT)');
    rw.prepare('INSERT INTO events (text) VALUES (?)').run(`key ${KEY}`);
    rw.close();
    const before = statSync(path).mtimeMs;

    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const rows = db.prepare<unknown[], { id: number; text: string }>('SELECT id, text FROM events').iterate();
    expect(auditRows(rows).counts).toEqual({ 'api-key': 1 });
    expect(() => db.exec('DELETE FROM events')).toThrow();
    db.close();
    expect(statSync(path).mtimeMs).toBe(before);
  });
});

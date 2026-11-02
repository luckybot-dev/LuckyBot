import { and, eq, lt, sql } from 'drizzle-orm';

import type { DB } from './client';
import { probeResponsesV2, turnResponsesV2 } from './schema';

/**
 * Trim rows that no reader can reach any more.
 *
 * Both tables are append-only history, but every reader is bounded by a cursor:
 *
 * - `turn_responses_v2` is read from the compaction cursor forward
 *   (`loadTurnResponses(chatId, cursorMs)` in the compaction controller, the
 *   wake-up path, and the post-turn refresh). Rows older than the cursor belong
 *   to context that has already been summarized, so nothing will load them
 *   again — except the startup single-row read, which takes only the newest row
 *   and is therefore unaffected by trimming the oldest.
 * - `probe_responses_v2` is written as an audit trail and read only by
 *   `loadLastProbeTime`, which takes one row (`ORDER BY id DESC LIMIT 1`).
 *   Probe prompts never re-enter primary context (CLAUDE.md, "Probe Gate"), so
 *   old rows are pure history.
 *
 * The live deployment reached 53 MB + 26 MB on these two tables while the
 * whole database was 108 MB, on a host with ~5 GB of disk left. Retention is
 * opt-in: `0` keeps everything, which is the current behaviour.
 *
 * Returns the number of rows deleted from each table.
 */
export const pruneHistory = (
  db: DB,
  chatId: string,
  options: { turnResponsesBeforeMs?: number; probeResponsesBeforeMs?: number },
): { turnResponses: number; probeResponses: number } => {
  const turnCutoff = options.turnResponsesBeforeMs;
  const probeCutoff = options.probeResponsesBeforeMs;

  let turnResponses = 0;
  if (turnCutoff != null && turnCutoff > 0) {
    turnResponses = db.delete(turnResponsesV2)
      .where(and(eq(turnResponsesV2.chatId, chatId), lt(turnResponsesV2.requestedAt, turnCutoff)))
      .run().changes;
  }

  let probeResponses = 0;
  if (probeCutoff != null && probeCutoff > 0) {
    probeResponses = db.delete(probeResponsesV2)
      .where(and(eq(probeResponsesV2.chatId, chatId), lt(probeResponsesV2.requestedAt, probeCutoff)))
      .run().changes;
  }

  return { turnResponses, probeResponses };
};

/**
 * Reclaim the space a delete does not return to the filesystem.
 *
 * SQLite frees deleted pages for reuse but keeps them in the file, so pruning
 * alone never shrinks the database. `VACUUM` rewrites it — which needs free
 * disk equal to the database size and takes an exclusive lock, so it must not
 * run while a turn is in flight. Returns false when it was skipped.
 */
export const vacuumIfNeeded = (db: DB, minimumFreeRatio = 0.25): boolean => {
  const pageCount = db.get<{ page_count: number }>(sql`PRAGMA page_count`);
  const freeList = db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`);
  const total = pageCount?.page_count ?? 0;
  const free = freeList?.freelist_count ?? 0;
  if (total === 0 || free / total < minimumFreeRatio) return false;
  db.run(sql`VACUUM`);
  return true;
};

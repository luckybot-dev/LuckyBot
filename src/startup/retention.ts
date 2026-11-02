import type { Logger } from '@guiiai/logg';

import type { Config } from '../config/config';
import { loadCompaction } from '../db';
import type { DB } from '../db/client';
import { pruneHistory, vacuumIfNeeded } from '../db/retention';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Apply `database.retention` before the first replay.
 *
 * Two cutoffs guard each table, and a row must clear both to be deleted:
 *
 * - the configured age, so an operator controls how much history is kept;
 * - the compaction cursor, because `turn_responses_v2` before it is summarized
 *   context that no reader will load again, while anything after it is still
 *   live — deleting there would remove turns the next wake-up expects.
 *
 * With `retention` unset both ages are 0 and nothing is deleted, so an existing
 * deployment behaves exactly as before until it opts in.
 */
export const pruneRetainedHistory = (
  db: DB,
  config: Config,
  chatIds: readonly string[],
  logger: Logger,
): void => {
  const retention = config.database.retention;
  const turnDays = retention?.turnResponsesDays ?? 0;
  const probeDays = retention?.probeResponsesDays ?? 0;
  const vacuumRatio = retention?.vacuumMinFreeRatio ?? 0;
  if (turnDays <= 0 && probeDays <= 0) return;

  const now = Date.now();
  const log = logger.withContext('retention');
  let totalTurn = 0;
  let totalProbe = 0;

  for (const chatId of chatIds) {
    // The cursor is the hard floor: never delete a turn response the next
    // wake-up or compaction could still read.
    const cursorMs = loadCompaction(db, chatId)?.newCursorMs ?? 0;
    const turnCutoff = turnDays > 0
      ? Math.max(now - turnDays * DAY_MS, cursorMs)
      : undefined;
    const probeCutoff = probeDays > 0 ? now - probeDays * DAY_MS : undefined;
    if (turnCutoff == null && probeCutoff == null) continue;

    const removed = pruneHistory(db, chatId, {
      turnResponsesBeforeMs: turnCutoff,
      probeResponsesBeforeMs: probeCutoff,
    });
    totalTurn += removed.turnResponses;
    totalProbe += removed.probeResponses;
    if (removed.turnResponses > 0 || removed.probeResponses > 0) {
      log.withFields({
        chatId,
        turnResponses: removed.turnResponses,
        probeResponses: removed.probeResponses,
        turnCutoff,
        probeCutoff,
      }).log('Pruned history');
    }
  }

  if (totalTurn === 0 && totalProbe === 0) return;

  let vacuumed = false;
  if (vacuumRatio > 0) {
    try {
      vacuumed = vacuumIfNeeded(db, vacuumRatio);
    } catch (error) {
      // VACUUM needs free disk equal to the database size and takes an
      // exclusive lock; failing it must not stop startup, the prune already
      // happened and freed pages are reusable in place.
      log.withError(error).warn('VACUUM failed; deleted pages stay allocated');
    }
  }

  log.withFields({ turnResponses: totalTurn, probeResponses: totalProbe, vacuumed })
    .log('Retention complete');
};

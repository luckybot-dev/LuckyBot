import { findSecrets, type RedactKind } from '../../plugins/src/redact';

export interface AuditRow {
  id: number;
  text: string | null;
}

export interface AuditHit {
  eventId: number;
  kind: RedactKind;
  length: number;
  preview: string;
}

export interface AuditReport {
  scanned: number;
  withText: number;
  counts: Record<string, number>;
  hits: AuditHit[];
}

const MAX_STARS = 36;

/**
 * First and last two characters, the rest as `*` (capped, the length is
 * printed separately). Matches of four characters or fewer are fully masked.
 * Counts code points, so CJK text is not cut inside a character.
 */
export const maskPreview = (value: string): string => {
  const chars = Array.from(value);
  if (chars.length <= 4) return '*'.repeat(chars.length);
  const stars = '*'.repeat(Math.min(chars.length - 4, MAX_STARS));
  return `${chars.slice(0, 2).join('')}${stars}${chars.slice(-2).join('')}`;
};

/** Runs the redactor's rules over archived text. Pure: it reads rows, nothing else. */
export const auditRows = (rows: Iterable<AuditRow>): AuditReport => {
  const report: AuditReport = { scanned: 0, withText: 0, counts: {}, hits: [] };
  for (const row of rows) {
    report.scanned++;
    if (!row.text) continue;
    report.withText++;
    for (const span of findSecrets(row.text)) {
      report.counts[span.kind] = (report.counts[span.kind] ?? 0) + 1;
      report.hits.push({
        eventId: row.id,
        kind: span.kind,
        length: span.end - span.start,
        preview: maskPreview(row.text.slice(span.start, span.end)),
      });
    }
  }
  return report;
};

export const formatReport = (report: AuditReport): string => {
  const lines = [
    `scanned ${report.scanned} events, ${report.withText} with text, ${report.hits.length} hits`,
  ];
  for (const [kind, n] of Object.entries(report.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`  ${kind}: ${n}`);
  }
  for (const hit of report.hits) {
    lines.push(`event ${hit.eventId}\t${hit.kind}\tlen=${hit.length}\t${hit.preview}`);
  }
  return lines.join('\n');
};

import type { Logger } from '@guiiai/logg';

import type {
  ConversationEntry,
  InputPart,
  OutputPart,
  TextPart,
} from '../unified-api/types';

export interface LlmRedactionHit {
  kind: string;
  length: number;
  hash: string;
}

/**
 * What the plugin host composes from the active plugins' `redactText` /
 * `inspectText`. Both are pure and synchronous. `inspect` is the shadow-mode
 * companion: it reports what `redact` would remove without removing it.
 */
export interface LlmRedactor {
  redact: (text: string) => string;
  inspect?: (text: string) => LlmRedactionHit[];
}

// A process-wide slot rather than a parameter: seven call sites (primary, probe,
// compaction, memory, media alt text, plugin callModel/ask) reach `callLlm`, and
// the boundary is the one place all of them share. The plugin host installs the
// redactor on start and removes it on stop; nothing else writes it.
let installed: LlmRedactor | undefined;

export const installLlmRedactor = (redactor: LlmRedactor | undefined): void => {
  installed = redactor;
};

export const getLlmRedactor = (): LlmRedactor | undefined => installed;

const MARKER_RE = /\[redacted:([a-z-]+)\]/g;
const MAX_LOGGED_HITS = 100;

const countMarkers = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!text.includes('[redacted:')) return counts;
  for (const m of text.matchAll(MARKER_RE)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return counts;
};

/** Returns the same array when `fn` changed no element, so unchanged requests stay identical. */
const mapKeepingIdentity = <T>(items: readonly T[], fn: (item: T) => T): T[] => {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const next = fn(items[i]!);
    if (next !== items[i] && !out) out = items.slice(0, i);
    out?.push(next);
  }
  return out ?? (items as T[]);
};

const mapJsonStrings = (value: unknown, fn: (text: string) => string): unknown => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return mapKeepingIdentity(value, v => mapJsonStrings(v, fn));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    let changed = false;
    const mapped = entries.map(([k, v]) => {
      const nk = fn(k);
      const nv = mapJsonStrings(v, fn);
      if (nk !== k || nv !== v) changed = true;
      return [nk, nv] as const;
    });
    return changed ? Object.fromEntries(mapped) : value;
  }
  return value;
};

export interface RedactedRequest {
  entries: ConversationEntry[];
  system: string;
}

/**
 * Applies the installed redactor to every text the request will carry: the
 * system prompt, user/system/assistant text, tool-call arguments (string leaves
 * of the JSON) and tool results. Images, reasoning blocks and tool schemas are
 * left alone; so are the persisted events and turn responses, which never pass
 * through here. Without an installed redactor, or when it changes nothing, the
 * very same objects come back.
 */
export const redactRequest = (
  entries: ConversationEntry[],
  system: string,
  log: Logger,
  label: string,
): RedactedRequest => {
  const redactor = installed;
  if (!redactor) return { entries, system };

  const removed = new Map<string, number>();
  const wouldRemove = new Map<string, number>();
  const hits: LlmRedactionHit[] = [];

  const text = (s: string): string => {
    if (s === '') return s;
    if (redactor.inspect) {
      for (const hit of redactor.inspect(s)) {
        wouldRemove.set(hit.kind, (wouldRemove.get(hit.kind) ?? 0) + 1);
        if (hits.length < MAX_LOGGED_HITS) hits.push(hit);
      }
    }
    const out = redactor.redact(s);
    if (out !== s) {
      const before = countMarkers(s);
      for (const [kind, n] of countMarkers(out)) {
        const added = n - (before.get(kind) ?? 0);
        if (added > 0) removed.set(kind, (removed.get(kind) ?? 0) + added);
      }
    }
    return out;
  };

  const textPart = (p: TextPart): TextPart => {
    const next = text(p.text);
    return next === p.text ? p : { ...p, text: next };
  };

  const inputPart = (p: InputPart): InputPart => (p.kind === 'text' ? textPart(p) : p);

  const toolArgs = (args: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      // The IR guarantees parseable args; plain text redaction is the safe fallback.
      return text(args);
    }
    const mapped = mapJsonStrings(parsed, text);
    return mapped === parsed ? args : JSON.stringify(mapped);
  };

  const outputPart = (p: OutputPart): OutputPart => {
    switch (p.kind) {
    case 'text': return textPart(p);
    case 'toolCall': {
      const args = toolArgs(p.args);
      return args === p.args ? p : { ...p, args };
    }
    case 'textGroup': {
      const content = mapKeepingIdentity(p.content, textPart);
      return content === p.content ? p : { ...p, content };
    }
    case 'reasoning': return p;
    }
  };

  const entry = (e: ConversationEntry): ConversationEntry => {
    if (e.kind === 'toolResult') {
      if (typeof e.payload === 'string') {
        const payload = text(e.payload);
        return payload === e.payload ? e : { ...e, payload };
      }
      const payload = mapKeepingIdentity(e.payload, inputPart);
      return payload === e.payload ? e : { ...e, payload };
    }
    if (e.role === 'assistant') {
      const parts = mapKeepingIdentity(e.parts, outputPart);
      return parts === e.parts ? e : { ...e, parts };
    }
    const parts = mapKeepingIdentity(e.parts, inputPart);
    return parts === e.parts ? e : { ...e, parts };
  };

  const result: RedactedRequest = {
    system: text(system),
    entries: mapKeepingIdentity(entries, entry),
  };

  if (removed.size > 0 || wouldRemove.size > 0) {
    // Counts and, in shadow mode, kind/length/hash per hit. Never the matched text.
    log.withFields({
      label,
      ...(removed.size > 0 ? { redacted: Object.fromEntries(removed) } : {}),
      ...(wouldRemove.size > 0 ? { shadow: Object.fromEntries(wouldRemove), shadowHits: hits } : {}),
    }).debug(wouldRemove.size > 0 ? 'Redaction shadow run (request unchanged)' : 'Redacted secrets from request');
  }
  return result;
};

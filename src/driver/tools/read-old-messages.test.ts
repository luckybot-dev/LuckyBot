import { describe, expect, it, vi } from 'vitest';

import { MAX_READ_OLD_MESSAGE_IDS, createReadOldMessagesTool } from './read-old-messages';

describe('read_old_messages tool', () => {
  it('exposes only message_ids, with the upper bound baked into the schema', () => {
    const tool = createReadOldMessagesTool(() => '');
    expect(Object.keys(tool.parameters.properties as object)).toEqual(['message_ids']);
    expect(tool.parameters).toMatchObject({
      properties: { message_ids: { type: 'array', minItems: 1, maxItems: MAX_READ_OLD_MESSAGE_IDS } },
      required: ['message_ids'],
    });
    expect(tool.validate({ message_ids: ['1'] }).valid).toBe(true);
    expect(tool.validate({ message_ids: [] }).valid).toBe(false);
    expect(tool.validate({ message_ids: Array.from({ length: MAX_READ_OLD_MESSAGE_IDS + 1 }, (_, i) => String(i)) }).valid).toBe(false);
  });

  it('returns the rendered chatlog XML and keeps the tool loop going', async () => {
    const read = vi.fn((ids: string[]) => `<message id="${ids[0]}">hi</message>`);
    const result = await createReadOldMessagesTool(read).execute({ message_ids: ['42'] });
    expect(read).toHaveBeenCalledWith(['42']);
    expect(result).toEqual({ content: '<message id="42">hi</message>', requiresFollowUp: true });
  });

  it('deduplicates and drops empty IDs before reading', async () => {
    const read = vi.fn(() => '<message/>');
    await createReadOldMessagesTool(read).execute({ message_ids: ['1', '1', '', '2', '2'] });
    expect(read).toHaveBeenCalledWith(['1', '2']);
  });

  // Compaction summaries cite `(ref: msg#m4f8a2c01)`; the prefix is notation, not
  // part of the id, and an `m...` alias must survive to the resolver unchanged.
  it('strips a leading msg# from summary refs and passes aliases through', async () => {
    const read = vi.fn(() => '<message/>');
    await createReadOldMessagesTool(read).execute({ message_ids: ['msg#m4f8a2c01', ' msg#m4f8a2c01 ', '42'] });
    expect(read).toHaveBeenCalledWith(['m4f8a2c01', '42']);
  });

  it('counts the limit after stripping msg#, not before', async () => {
    const read = vi.fn(() => '<message/>');
    const ids = Array.from({ length: MAX_READ_OLD_MESSAGE_IDS }, (_, i) => `msg#${i}`);
    const result = await createReadOldMessagesTool(read).execute({ message_ids: ids });
    expect(result.content).toBe('<message/>');
    expect(read).toHaveBeenCalledWith(ids.map(id => id.slice(4)));
  });

  it('points the model at truncated quotes and summary refs', () => {
    const tool = createReadOldMessagesTool(() => '');
    expect(tool.description).toContain('preview');
    expect(tool.description).toContain('msg#ID');
    expect(tool.description).toContain('msg#` is accepted');
  });

  it('refuses an empty selection without reading', async () => {
    const read = vi.fn();
    const result = await createReadOldMessagesTool(read).execute({ message_ids: [] });
    expect(JSON.parse(result.content as string).error).toMatch(/at least one/);
    expect(result.requiresFollowUp).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses more IDs than the limit without reading', async () => {
    const read = vi.fn();
    const ids = Array.from({ length: MAX_READ_OLD_MESSAGE_IDS + 1 }, (_, i) => String(i));
    const result = await createReadOldMessagesTool(read).execute({ message_ids: ids });
    expect(JSON.parse(result.content as string).error).toMatch(/Too many/);
    expect(read).not.toHaveBeenCalled();
  });

  it('reports when none of the IDs resolve to a message', async () => {
    const result = await createReadOldMessagesTool(() => '   \n').execute({ message_ids: ['42'] });
    expect(JSON.parse(result.content as string).error).toMatch(/No messages found/);
    expect(result.requiresFollowUp).toBe(true);
  });
});

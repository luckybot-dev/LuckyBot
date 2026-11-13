import { createTool } from './create-tool';
import type { CahciuaTool } from './types';

/** Maximum number of message IDs accepted by a single `read_old_messages` call. */
export const MAX_READ_OLD_MESSAGE_IDS = 10;

/**
 * Look up older messages in the current chat by their message IDs.
 *
 * The chat is implicit: the tool is bound to the chat whose context is being
 * built, so the model can never read another chat's history. `read` receives
 * already-deduplicated IDs and returns the messages rendered in the canonical
 * chatlog XML format.
 */
export const createReadOldMessagesTool = (
  read: (messageIds: string[]) => Promise<string> | string,
): CahciuaTool => createTool({
  name: 'read_old_messages',
  description:
    'Read older messages in the current chat by their message IDs, in full. '
    + 'Use it when a quote was cut to a short preview, or a conversation summary cites a `(ref: msg#ID)` '
    + 'and you need the original wording. Pass the ids exactly as they appear; a leading `msg#` is accepted. '
    + 'Skip it when the preview already tells you what you need.',
  parameters: {
    type: 'object',
    properties: {
      message_ids: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_READ_OLD_MESSAGE_IDS,
        items: { type: 'string' },
        description: `The message IDs to read, as they appear in the chatlog or a summary ref. Accepts up to ${MAX_READ_OLD_MESSAGE_IDS} IDs per call.`,
      },
    },
    required: ['message_ids'],
  },
  execute: async input => {
    const { message_ids } = input as { message_ids: string[] };
    // Summaries cite refs as `msg#m4f8a2c01`; the prefix is notation, not part of the id.
    const normalize = (id: string) => String(id).trim().replace(/^msg#/, '');
    const messageIds = [...new Set(message_ids.map(normalize).filter(id => id !== ''))];
    if (messageIds.length === 0)
      return { content: JSON.stringify({ error: 'message_ids must contain at least one message ID.' }), requiresFollowUp: true };
    if (messageIds.length > MAX_READ_OLD_MESSAGE_IDS)
      return { content: JSON.stringify({ error: `Too many message IDs: ${messageIds.length} (max ${MAX_READ_OLD_MESSAGE_IDS}).` }), requiresFollowUp: true };

    const xml = await read(messageIds);
    if (xml.trim() === '')
      return { content: JSON.stringify({ error: 'No messages found for the given IDs in this chat.' }), requiresFollowUp: true };
    return { content: xml, requiresFollowUp: true };
  },
});

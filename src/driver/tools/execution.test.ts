import { describe, expect, it, vi } from 'vitest';

import { executeToolCall } from './execution';

describe('executeToolCall', () => {
  it('answers a stored call to a removed tool (sleep) with an unknown-tool error', async () => {
    const log: any = { withFields: () => log, withError: () => log, error: vi.fn() };
    const result = await executeToolCall('call-1', 'sleep', '{"seconds":5}', [], log);
    expect(result).toMatchObject({ kind: 'toolResult', callId: 'call-1', requiresFollowUp: true });
    expect(JSON.parse(result.payload as string)).toEqual({ error: 'Unknown tool: sleep' });
  });
});

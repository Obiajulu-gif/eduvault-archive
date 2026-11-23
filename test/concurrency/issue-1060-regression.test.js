// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateFieldAuthorization } from '@/lib/backend/conflictResolver';

describe('concurrency regression contract (#1060)', () => {
  it('rejects an unauthorized concurrent writer before any mutation can occur', () => {
    const result = validateFieldAuthorization({
      actor: { id: 'attacker', role: 'learner' },
      resourceOwnerId: 'creator',
      fieldsToUpdate: ['price'],
    });
    expect(result.authorized).toBe(false);
    expect(result.error).toMatch(/authorized/i);
  });
});

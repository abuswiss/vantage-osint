import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAuthState, settleAnonymousAuthState } from '@/services/auth-state';

describe('auth state in an intentionally account-free product variant', () => {
  it('settles the boot default as anonymous without loading Clerk', () => {
    assert.equal(getAuthState().isPending, true);
    settleAnonymousAuthState();
    assert.deepEqual(getAuthState(), { user: null, isPending: false });
  });
});

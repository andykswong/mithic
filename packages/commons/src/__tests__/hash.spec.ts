import { describe, it } from '@jest/globals';
import { CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { ContentId } from '../hash.js';

describe('ContentId', () => {
  it('should be compatible with CID', () => {
    const _ = CID.create(1, 0x55, identity.digest(new Uint8Array())) satisfies ContentId;
  });
});

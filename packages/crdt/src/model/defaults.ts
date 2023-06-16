import { ErrorCode, operationError, sha256 } from '@mithic/commons';
import { AggregateEvent } from '../aggregate.js';

/** Default eventRef implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
export const defaultEventRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const dagCbor = await import('@ipld/dag-cbor');
    return <Ref>(event: AggregateEvent<string, Ref>) =>
      CID.createV1(dagCbor.code, sha256.digest(dagCbor.encode(event))) as unknown as Ref;
  } catch (_) {
    return () => { throw operationError('multiformats or @ipld/dag-cbor not available', ErrorCode.InvalidState); };
  }
})();

/** Default voidRef implementation that uses multiformats as optional dependency. */
export const defaultVoidRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { identity } = await import('multiformats/hashes/identity');
    return <Ref>() => CID.createV1(0x55, identity.digest(new Uint8Array())) as unknown as Ref;
  } catch (_) {
    return () => { throw operationError('multiformats not available', ErrorCode.InvalidState); };
  }
})();

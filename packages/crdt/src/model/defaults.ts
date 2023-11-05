import { InvalidStateError } from '@mithic/commons';

/** Default eventRef implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
export const defaultEventRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { sha256 } = await import('multiformats/hashes/sha2');
    const dagCbor = await import('@ipld/dag-cbor');
    return async <Event, Ref>(event: Event) =>
      CID.create(1, dagCbor.code, await sha256.digest(dagCbor.encode(event))) as unknown as Ref;
  } catch (_) {
    return () => { throw new InvalidStateError('multiformats or @ipld/dag-cbor not available'); };
  }
})();

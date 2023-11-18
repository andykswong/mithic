import { InvalidStateError } from '@mithic/commons';

/** Default getEventKey implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
export const getCID = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { sha256 } = await import('multiformats/hashes/sha2');
    const dagCbor = await import('@ipld/dag-cbor');
    return async <K, Event>(event: Event) =>
      CID.create(1, dagCbor.code, await sha256.digest(dagCbor.encode(event))) as unknown as K;
  } catch (_) {
    return () => { throw new InvalidStateError('multiformats or @ipld/dag-cbor not available'); };
  }
})();

/** Default CID-based key implementation that uses multiformats as optional dependency. */
export const decodeCID = await (async () => {
  try {
    const { CID } = await import('multiformats');

    return function decodeCID<K>(key: string) {
      return CID.parse(key) as unknown as K;
    };
  } catch (_) {
    return () => { throw new InvalidStateError('multiformats not available'); };
  }
})();

/** Default value hash function using JSON stringify. */
export const defaultHash = <V>(value: V) => JSON.stringify(value);

import { InvalidStateError, sha256 } from '@mithic/commons';
import { StandardEvent } from '@mithic/cqrs';

/** Default eventRef implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
export const defaultEventRef = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const dagCbor = await import('@ipld/dag-cbor');
    return <Ref>(event: StandardEvent<string, unknown, Ref>) =>
      CID.createV1(dagCbor.code, sha256.digest(dagCbor.encode(event))) as unknown as Ref;
  } catch (_) {
    return () => { throw new InvalidStateError('multiformats or @ipld/dag-cbor not available'); };
  }
})();

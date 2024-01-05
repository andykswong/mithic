import { ContentId, InvalidStateError } from '@mithic/commons';

/** Default getEventKey implementation that uses multiformats and @ipld/dag-cbor as optional dependency. */
export const getCID = await (async () => {
  try {
    const { CID } = await import('multiformats');
    const { sha256 } = await import('multiformats/hashes/sha2');
    const dagCbor = await import('@ipld/dag-cbor');
    return async <K, Event>(event: Event) =>
      CID.create(1, dagCbor.code, await sha256.digest(dagCbor.encode(event))) as unknown as K;
  } catch {
    return () => { throw new InvalidStateError('multiformats or @ipld/dag-cbor not available'); };
  }
})();

/** Default value stringify function. */
export const defaultStringify = await (async () => {
  try {
    const { base32hex } = await import('multiformats/bases/base32');
    return async <V>(value: V) => {
      if (ArrayBuffer.isView((value as ContentId)?.['/'])) {
        return `${value}`;
      }
      if (ArrayBuffer.isView(value)) {
        return base32hex.baseEncode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
      return JSON.stringify(value);
    }
  } catch {
    return <V>(value: V) => JSON.stringify(value);
  }
})();

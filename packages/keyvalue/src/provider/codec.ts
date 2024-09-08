import type { Codec } from '@mithic/commons';
import { decode } from 'cbor-x/decode';
import { encode } from 'cbor-x/encode';
import { type KeySelector, type StoreErrorPayload } from '../types.ts';

/** Key-value store operation types. */
export const KVStoreOp = {
  Response: 1,
  Open: 2,
  Close: 3,
  Exist: 4,
  Get: 5,
  Update: 6,
  Incr: 7,
  CAS: 8,
  Keys: 9,
} as const;

export type KVStoreOp = typeof KVStoreOp[keyof typeof KVStoreOp];

/** I/O operation message. */
export type KVStoreMessage = {
  op: KVStoreOp,
  seq: number,
  bucket?: string,
} & ({
  op: typeof KVStoreOp.Response,
  success?: boolean,
  error?: StoreErrorPayload,
  keys?: string[],
  values?: (Uint8Array | null)[],
  counter?: bigint,
  cursor?: string,
} | {
  op: typeof KVStoreOp.Open | typeof KVStoreOp.Close,
  bucket: string,
} | {
  op: typeof KVStoreOp.Exist,
  bucket: string,
  key: string,
} | {
  op: typeof KVStoreOp.Get,
  bucket: string,
  keys: string[],
} | {
  op: typeof KVStoreOp.Update,
  bucket: string,
  keyValues: [key: string, value: Uint8Array | null][],
} | {
  op: typeof KVStoreOp.Incr,
  bucket: string,
  key: string,
  delta: bigint,
} | {
  op: typeof KVStoreOp.CAS,
  bucket: string,
  key: string,
  oldValue?: Uint8Array,
  newValue?: Uint8Array,
} | {
  op: typeof KVStoreOp.Keys,
  bucket: string,
  selector?: KeySelector,
  cursor?: string,
});

export const KVStoreMessage: Codec<KVStoreMessage> = {
  /**
   * Encodes a KV store message.
   * format: [op (2 bytes), bucket len (4 bytes), ...bucket]
   */
  encode(message: KVStoreMessage): Uint8Array {
    return encode(message);
  },

  /** Decodes message from binary data. */
  decode(message: Uint8Array): KVStoreMessage | undefined {
    return decode(message);
  }
};

/**
 * Async-to-sync boundary using SharedArrayBuffer + Atomics.
 *
 * Uses a resizable SharedArrayBuffer with a hybrid serialization protocol:
 * - Small/structured values: JSON with BigInt support
 * - Uint8Array (top-level or nested in objects): raw bytes packed before JSON
 *
 * SAB layout: [signal: Int32] [resultType: Int32] [resultLen: Int32] [data...]
 * - signal = 0: waiting, != 0: done
 * - resultType: 0 = undefined, 1 = JSON (may have embedded blobs), 2 = raw bytes, -1 = error
 * - resultLen: total byte length of data region
 *
 * Data region for TYPE_JSON with embedded blobs:
 *   [blobsLen: Uint32] [blob1...] [blob2...] [json bytes...]
 *   JSON contains { __bytes: offset, __len: N } referencing positions within the blobs section.
 *   blobsLen = 0 means no blobs (data is pure JSON).
 */

const HEADER_SIZE = 12;
const INITIAL_SIZE = 1024 * 64;
const MAX_SIZE = 1024 * 1024 * 64;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const TYPE_UNDEFINED = 0;
const TYPE_JSON = 1;
const TYPE_BYTES = 2;
const TYPE_ERROR = -1;

export type BlockingCallFn = (call: number, id: number | null, payload: unknown) => unknown;
export type CallHandler = (call: number, id: number | null, payload: unknown) => Promise<unknown>;

interface CallMessage {
  sharedBuffer: SharedArrayBuffer;
  call: number;
  id: number | null;
  payload: unknown;
}

// ─── Serialization ────────────────────────────────────────────────────────────

export interface Packed {
  type: number;
  data: Uint8Array;
}

export function pack(value: unknown): Packed {
  if (value === undefined) return { type: TYPE_UNDEFINED, data: new Uint8Array(0) };
  if (value instanceof Uint8Array) return { type: TYPE_BYTES, data: value };

  const blobs: Uint8Array[] = [];
  let blobOffset = 0;

  const json = JSON.stringify(value, function (_key, val) {
    // Check the raw property on `this` since JSON.stringify calls .toJSON() before the replacer
    const raw = _key ? (this as Record<string, unknown>)[_key] : val;
    if (raw instanceof Uint8Array) {
      const ref = { __bytes: blobOffset, __len: raw.byteLength };
      blobs.push(raw);
      blobOffset += raw.byteLength;
      return ref;
    }
    if (raw instanceof Date) return { __date: raw.getTime() };
    if (typeof val === 'bigint') return { __bigint: val.toString() };
    return val;
  });

  const jsonBytes = textEncoder.encode(json);

  if (blobs.length === 0) {
    // No blobs — blobsLen prefix = 0, then JSON
    const data = new Uint8Array(4 + jsonBytes.byteLength);
    new DataView(data.buffer).setUint32(0, 0, true);
    data.set(jsonBytes, 4);
    return { type: TYPE_JSON, data };
  }

  // Layout: [blobsLen: 4] [blobs...] [json...]
  const blobsLen = blobOffset;
  const totalLen = 4 + blobsLen + jsonBytes.byteLength;
  const data = new Uint8Array(totalLen);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, blobsLen, true);

  let pos = 4;
  for (const blob of blobs) {
    data.set(blob, pos);
    pos += blob.byteLength;
  }
  data.set(jsonBytes, pos);

  return { type: TYPE_JSON, data };
}

export function unpack(type: number, data: Uint8Array): unknown {
  if (type === TYPE_UNDEFINED) return undefined;
  if (type === TYPE_BYTES) return data;

  // TYPE_JSON or TYPE_ERROR: [blobsLen: 4] [blobs...] [json...]
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const blobsLen = dv.getUint32(0, true);
  const blobBase = data.subarray(4, 4 + blobsLen);
  const jsonBytes = data.subarray(4 + blobsLen);
  const jsonStr = textDecoder.decode(jsonBytes);

  return JSON.parse(jsonStr, (_key, val) => {
    if (val && typeof val === 'object') {
      if ('__bytes' in val && '__len' in val) {
        return blobBase.slice(val.__bytes, val.__bytes + val.__len);
      }
      if ('__date' in val) return new Date(val.__date);
      if ('__bigint' in val) return BigInt(val.__bigint);
    }
    return val;
  });
}

// ─── Worker side ──────────────────────────────────────────────────────────────

export function createBlockingCall(target: MessagePort): BlockingCallFn {
  const sharedBuffer = new SharedArrayBuffer(INITIAL_SIZE, { maxByteLength: MAX_SIZE });
  const headerView = new Int32Array(sharedBuffer, 0, 3);

  return (call: number, id: number | null, payload: unknown): unknown => {
    Atomics.store(headerView, 0, 0);
    target.postMessage({ sharedBuffer, call, id, payload } satisfies CallMessage);
    Atomics.wait(headerView, 0, 0);

    const resultType = headerView[1]!;
    const resultLen = headerView[2]!;

    if (resultType === TYPE_UNDEFINED) return undefined;

    const copy = new Uint8Array(resultLen);
    copy.set(new Uint8Array(sharedBuffer, HEADER_SIZE, resultLen));

    if (resultType === TYPE_ERROR) throw unpack(TYPE_JSON, copy);
    return unpack(resultType, copy);
  };
}

// ─── I/O loop side ────────────────────────────────────────────────────────────

export function handleBlockingCalls(handler: CallHandler, port: MessagePort): void {
  port.onmessage = async (event: MessageEvent<CallMessage>) => {
    const { sharedBuffer, call, id, payload } = event.data;
    const headerView = new Int32Array(sharedBuffer, 0, 3);

    let packed: Packed;
    let resultType: number;

    try {
      packed = pack(await handler(call, id, payload));
      resultType = packed.type;
    } catch (error) {
      packed = pack(error);
      resultType = TYPE_ERROR;
    }

    const { data } = packed;
    if (data.byteLength > 0) {
      ensureCapacity(sharedBuffer, HEADER_SIZE + data.byteLength);
      new Uint8Array(sharedBuffer, HEADER_SIZE, data.byteLength).set(data);
    }

    headerView[1] = resultType;
    headerView[2] = data.byteLength;
    Atomics.add(headerView, 0, 1);
    Atomics.notify(headerView, 0);
  };
}

function ensureCapacity(sab: SharedArrayBuffer, needed: number): void {
  if (sab.byteLength < needed) {
    (sab as SharedArrayBuffer & { grow(size: number): void }).grow(needed);
  }
}

import { Equal, ToString } from './equal.js';

/** A content hash ID. */
export interface ContentId<
  Code extends number = number,
  HashCode extends number = number
> extends Equal<ContentId<Code, HashCode>>, ToString {
  /** Multicodec code of this ID. */
  readonly code: Code;

  /** Multihash value of this ID. */
  readonly multihash: MultihashDigest<HashCode>;

  /** Byte representation of this ID. */
  readonly bytes: Uint8Array;

  /** Byte representation of this ID. */
  readonly ['/']: Uint8Array;

  /** Returns a JSON representation of this ID. */
  toJSON(): { '/': string };

  toString(base?: MultibaseEncoder<string>): string;
}

/** A multihash digest and its hashing algorithm. */
export interface MultihashDigest<Code extends number = number> {
  /** Code of the multihash */
  code: Code;

  /** Raw digest */
  digest: Uint8Array;

  /** Binary representation of this multihash digest. */
  bytes: Uint8Array;
}

/** Encodes bytes into multibase of a specific encoding. */
export interface MultibaseEncoder<Prefix extends string> {
  /** Prefix character for that base encoding. */
  prefix: Prefix;

  /** Encodes binary data into **multibase** string (which will have a prefix added). */
  encode: (bytes: Uint8Array) => string;
}

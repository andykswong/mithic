import crypto from 'crypto';
import { ByteView, MultibaseEncoder, MultihashDigest, Phantom, SyncMultihashHasher } from 'multiformats';
import * as Digest from 'multiformats/hashes/digest';
import { Equal, ToString } from './equal.js';

/** A content hash ID. */
export interface ContentId<
  Data = unknown,
  Format extends number = number,
  Alg extends number = number
> extends Equal<ContentId<Data, Format, Alg>>, Phantom<Data>, ToString {
  /** Multicodec code of this ID. */
  readonly code: Format;

  /** Multihash value of this ID. */
  readonly multihash: MultihashDigest<Alg>;

  /** Byte representation of this ID. */
  readonly bytes: ByteView<ContentId<Data, Format, Alg>>;

  /** Returns a JSON representation of this ID. */
  toJSON(): { '/': string };

  toString(base?: MultibaseEncoder<string>): string;
}

/** An implementation of SyncMultihashHasher. */
export class Hasher<Code extends number = number> implements SyncMultihashHasher<Code> {
  public constructor(
    public readonly name: string,
    public readonly code: Code,
    private readonly encode: (input: Uint8Array) => Uint8Array
  ) {
  }

  public digest(input: Uint8Array): MultihashDigest<Code> {
    const result = this.encode(input)
    return Digest.create(this.code, result);
  }
}

/** A SyncMultihashHasher that uses the SHA2-256 algorithm. */
export const sha256 = new Hasher('sha2-256', 0x12, (input) => crypto.createHash('sha256').update(input).digest());

/** A SyncMultihashHasher that uses the SHA2-512 algorithm. */
export const sha512 = new Hasher('sha2-512', 0x13, (input) => crypto.createHash('sha512').update(input).digest());

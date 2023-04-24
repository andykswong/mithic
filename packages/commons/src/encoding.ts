import { BlockCodec, ByteView, CID, MultibaseCodec, MultibaseEncoder, MultihashDigest, Phantom } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import * as raw from 'multiformats/codecs/raw';
import { Equal } from './equal.js';

/** A content hash ID. */
export interface ContentId<
  Data = unknown,
  Format extends number = number,
  Alg extends number = number
> extends Equal<ContentId<Data, Format, Alg>>, Phantom<Data> {
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

/** An encoder of data to string. */
export interface DataStringEncoder<T = Uint8Array> {
  //** Encodes data into string */
  encode(data: T): string;
}

/** A decoder of data from string. */
export interface DataStringDecoder<T = Uint8Array> {
  /** Decodes string. */
  decode(content: string): T;
}

/** An encoding of data to and from string. */
export interface DataStringEncoding<T = Uint8Array> extends DataStringEncoder<T>, DataStringDecoder<T> {
}

/** An encoding of data to and from JSON string. */
export class JsonEncoding<T> implements DataStringEncoding<T> {
  public encode(data: T): string {
    return JSON.stringify(data);
  }

  public decode(content: string): T {
    return JSON.parse(content);
  }
}

/** A {@link JsonEncoding} instance. */
export const JSON_ENCODING = new JsonEncoding<unknown>();

/** An encoding of {@link ContentId} to and from multibase string. */
export class CIDMultibaseEncoding implements DataStringEncoding<ContentId> {
  public constructor(
    /** Base encoding. */
    private readonly baseCodec: MultibaseCodec<string> = base64,
  ) {
  }

  public encode(data: ContentId): string {
    return data.toString(this.baseCodec.encoder);
  }

  public decode(content: string): ContentId {
    return CID.parse(content, this.baseCodec.decoder);
  }
}

/** An encoding of data block to and from multibase string. */
export class BlockMultibaseEncoding<T = Uint8Array> implements DataStringEncoding<T> {
  public constructor(
    /** Data binary encoding to use. */
    protected readonly codec: BlockCodec<number, T> = raw as unknown as BlockCodec<number, T>,
    /** Base encoding to use. */
    private readonly baseCodec: MultibaseCodec<string> = base64
  ) {
  }

  public encode(data: T): string {
    const bytes = this.codec.encode(data);
    return this.baseCodec.encoder.encode(bytes);
  }

  public decode(content: string): T {
    const bytes = this.baseCodec.decoder.decode(content);
    return this.codec.decode(bytes);
  }
}

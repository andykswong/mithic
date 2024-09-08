/** Encoder of object to bytes. */
export interface Encoder<T> {
  /** Encodes an input into bytes. */
  encode(input: T): Uint8Array;
}

/** Decoder of object from bytes. */
export interface Decoder<T> {
  /** Decodes from bytes. May support stream mode for processing data in chunks. */
  decode(message: Uint8Array, options?: { stream: boolean }): T | undefined;
}

/** Encoder/Decoder of object to/from bytes. */
export interface Codec<T> extends Encoder<T>, Decoder<T> { }

/** A {@link Codec} for UTF8 text. */
export class TextCodec implements Codec<string> {
  private readonly encoder = new TextEncoder();
  private readonly decoder: TextDecoder;

  public constructor(options?: { fatal?: boolean, ignoreBOM?: boolean }) {
    this.decoder = new TextDecoder('utf-8', options);
  }

  /** Returns "utf-8". */
  public get encoding(): string {
    return this.encoder.encoding;
  }

  public encode(input: string): Uint8Array {
    return this.encoder.encode(input);
  }

  public decode(data: Uint8Array, options?: { stream: boolean }): string {
    return this.decoder.decode(data, options);
  }
};

/** An identity {@link Codec}. */
export const IdentityCodec: Codec<Uint8Array> = {
  encode(data: Uint8Array): Uint8Array {
    return data;
  },
  decode(data: Uint8Array): Uint8Array {
    return data;
  }
};

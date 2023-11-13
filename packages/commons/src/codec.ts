/** Data encoder. */
export interface Encoder<V, T> {
  /** Encodes source data into specific encoding. */
  encode(data: V): T;
}

/** Data decoder. */
export interface Decoder<V, T> {
  /** Decodes data from specific encoding. */
  decode(data: T): V;
}

/** Data encoder and decoder. */
export interface Codec<V, T> extends Encoder<V, T>, Decoder<V, T> { }

/** An identity {@link Codec}. */
export const IdentityCodec: Codec<unknown, unknown> = {
  encode<V>(data: V): V {
    return data;
  },

  decode<V>(data: V): V {
    return data;
  }
};

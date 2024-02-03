import { Codec, ContentId } from '@mithic/commons';
import { MultihashDigest, MultibaseEncoder } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import { EventMeta } from '../eventstore/index.ts';

export class MockStorage implements Storage {
  data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    let i = 0;
    for (const key of this.data.keys()) {
      if (i++ === index) {
        return key;
      }
    }
    return null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

export class MockKey {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

export const MockKeyStringCodec: Codec<MockKey, string> = {
  encode(key: MockKey): string {
    return key.toString();
  },
  decode(value: string): MockKey {
    return new MockKey(value);
  }
};

export class MockId implements ContentId {
  code = 123;
  multihash!: MultihashDigest<number>;

  constructor(public bytes: Uint8Array) {
  }

  get ['/']() {
    return this.bytes;
  }

  toJSON(): { '/': string; } {
    return { '/': this.toString() };
  }

  toString(base: MultibaseEncoder<string> = base64): string {
    return base.encode(this.bytes);
  }

  equals(rhs: MockId): boolean {
    return this.toString() === rhs.toString();
  }

  static parse(id: string): MockId {
    return new MockId(base64.decode(id));
  }
}

export interface MockEvent<T = number> extends EventMeta<MockId> {
  readonly payload: T;

  readonly id: MockId;
}


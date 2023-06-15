import { ContentId } from '@mithic/commons';
import { MultihashDigest, MultibaseEncoder } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';

export class MockId implements ContentId {
  code = 123;
  multihash!: MultihashDigest<number>;

  constructor(public bytes: Uint8Array = new Uint8Array()) {
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
    return `${this}` === `${rhs}`;
  }

  static parse(id: string): MockId {
    return new MockId(base64.decode(id));
  }
}

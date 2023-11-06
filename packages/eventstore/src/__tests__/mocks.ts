import { ContentId } from '@mithic/commons';
import { MultihashDigest, MultibaseEncoder } from 'multiformats';
import { base64 } from 'multiformats/bases/base64';
import { EventMeta } from '../event.js';

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

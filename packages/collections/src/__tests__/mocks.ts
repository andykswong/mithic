import { Codec } from '@mithic/commons';

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
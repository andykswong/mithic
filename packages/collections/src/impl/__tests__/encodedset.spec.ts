import { MaybeAsyncSet } from '../../set.js';
import { EncodedSet } from '../encodedset.js';

class Key {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

const K1 = new Key('val1')
const K2 = new Key('val2');
const K3 = new Key('val3');

describe.each([
  () => new Set<string>(),
  () => new EncodedSet<string>(new Set())
])(EncodedSet.name, (backingSetFactory: () => MaybeAsyncSet<string>) => {
  let set: EncodedSet<Key, string>;

  beforeEach(() => {
    set = new EncodedSet(backingSetFactory(), (k) => k.toString());
    set.add(K1);
    set.add(K2);
  });

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${EncodedSet.name}]`);
  });

  describe('has', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      expect(await set.has(K1)).toBe(true);
      expect(await set.has(K2)).toBe(true);
      expect(await set.has(K3)).toBe(false);
    });
  });

  describe('add', () => {
    it('should add value correctly', async () => {
      await set.add(K3);
      expect(await set.set.has(K3.toString())).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete existing key', async () => {
      await set.delete(K2);
      expect(await set.set.has(K2.toString())).toBe(false);
    });

    it('should do nothing for non-existing key', async () => {
      await set.delete(K3);
    });
  });

  describe('hasMany', () => {
    it('should return true for existing keys and false for non-existing keys', async () => {
      const results = [];
      for await (const result of set.hasMany([K1, K2, K3])) {
        results.push(result);
      }
      expect(results).toEqual([true, true, false]);
    });
  });

  describe('addMany', () => {
    it('should add values', async () => {
      for await (const error of set.addMany([K1, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(true);
      expect(await set.has(K3)).toBe(true);
    });
  });

  describe('deleteMany', () => {
    it('should delete existing keys and do nothing for non-existing keys', async () => {
      for await (const error of set.deleteMany([K1, K2, K3])) {
        expect(error).toBeUndefined();
      }
      expect(await set.has(K1)).toBe(false);
      expect(await set.has(K2)).toBe(false);
    });
  });
});

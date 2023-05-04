import { HashMap } from '../hashmap.js';

class Key {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

const K1 = new Key('val1')
const K2 = new Key('val2');
const K3 = new Key('val3');
const KEYS = [K1, K2];

describe(HashMap.name, () => {
  let map: HashMap<Key, number>;
  let underlying: Map<string, [Key, number]>;

  beforeEach(() => {
    underlying = new Map();
    map = new HashMap(underlying, k => k.toString());
    map.set(K1, 1);
    map.set(K2, 2);
  });

  it('should have the correct size', () => {
    expect(map.size).toBe(KEYS.length);
  });

  it('should support has() operation correctly', () => {
    expect(map.has(K1)).toBe(true);
    expect(map.has(K2)).toBe(true);
    expect(map.has(K3)).toBe(false);
  });


  it('should support get/set operation correctly', () => {
    const value = 3;
    expect(map.set(K3, value)).toBe(map);
    expect(map.get(K3)).toBe(value);
    expect(map.size).toBe(KEYS.length + 1);
  });

  it('should support delete() operation correctly', () => {
    expect(map.delete(K3)).toBe(false);

    expect(map.delete(K2)).toBe(true);
    expect(map.has(K2)).toBe(false);
    expect(map.size).toBe(KEYS.length - 1);
  });

  it('should support clear() operation correctly', () => {
    map.clear();
    expect(map.size).toBe(0);
  });

  it('should supply each value to forEach', () => {
    let i = 0;

    map.forEach((v, k, self) => {
      expect(k).toBe(KEYS[i]);
      expect(v).toBe(++i);
      expect(self).toBe(map);
    });
    expect(i).toBe(KEYS.length);
  });

  test.each([
    ['self', () => map, () => underlying.values()],
    ['self.entries()', () => map.entries() as Iterable<unknown>, () => underlying.values()],
    ['self.keys()', () => map.keys(), () => KEYS],
    ['self.values()', () => map.values(), () => [1, 2]],
  ])('should be iterable by %s', (_, iterable, expected) => {
    expect([...iterable()]).toEqual([...expected()]);
  });

  it('should have correct string tag', () => {
    expect(map.toString()).toBe(`[object ${HashMap.name}]`);
  });
});

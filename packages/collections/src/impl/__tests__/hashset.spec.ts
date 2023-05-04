import { HashSet } from '../hashset.js';

class Value {
  public constructor(private readonly value: string) { }

  public toString(): string {
    return this.value;
  }
}

const V1 = new Value('val1')
const V2 = new Value('val2');
const V3 = new Value('val3');
const VALUES = [V1, V2];

describe(HashSet.name, () => {
  let set: HashSet<Value>;
  let map: Map<string, Value>;

  beforeEach(() => {
    map = new Map();
    set = new HashSet(map, (k) => k.toString());
    set.add(V1);
    set.add(V2);
  });

  it('should have the correct size', () => {
    expect(set.size).toBe(VALUES.length);
  });

  it('should support has() operation correctly', () => {
    expect(set.has(V1)).toBe(true);
    expect(set.has(V2)).toBe(true);
    expect(set.has(V3)).toBe(false);
  });


  it('should support add() operation correctly', () => {
    expect(set.add(V3)).toBe(set);
    expect(set.has(V3)).toBe(true);
    expect(set.size).toBe(VALUES.length + 1);
  });

  it('should support delete() operation correctly', () => {
    expect(set.delete(V3)).toBe(false);

    expect(set.delete(V2)).toBe(true);
    expect(set.has(V2)).toBe(false);
    expect(set.size).toBe(VALUES.length - 1);
  });

  it('should support clear() operation correctly', () => {
    set.clear();
    expect(set.size).toBe(0);
  });

  it('should supply each value to forEach', () => {
    let i = 0;

    set.forEach((k, v, self) => {
      expect(k).toBe(VALUES[i]);
      expect(v).toBe(VALUES[i]);
      expect(self).toBe(set);
      ++i;
    });
    expect(i).toBe(VALUES.length);
  });

  test.each([
    ['self', () => set, undefined],
    ['self.entries()', () => set.entries() as Iterable<unknown>, (v: Value) => [v, v] as unknown],
    ['self.keys()', () => set.keys(), undefined],
    ['self.values()', () => set.values(), undefined],
  ])('should be iterable by %s', (_, iterable, mapper) => {
    const expected = VALUES.map(mapper || ((v) => v));
    const actual = Array.from(iterable());
    expect(actual).toEqual(expected);
  });

  it('should have correct string tag', () => {
    expect(set.toString()).toBe(`[object ${HashSet.name}]`);
  });
});

import { beforeEach, describe, expect, it } from '@jest/globals';
import { BloomFilter } from '../bloomfilter.ts';

describe(BloomFilter.name, () => {
  let filter: BloomFilter<string>;

  beforeEach(() => {
    filter = new BloomFilter({ m: 1000, k: 3 });
  });

  it('should have correct string tag', () => {
    expect(filter.toString()).toBe(`[object ${BloomFilter.name}]`);
  });

  describe('add', () => {
    it('should add a value to the filter', () => {
      filter.add('foo');
      expect(filter.has('foo')).toBe(true);
    });

    it('should increment the count of added values', () => {
      filter.add('foo');
      filter.add('bar');
      expect(filter.size).toBe(2);
    });

    it('should handle adding the same value twice', () => {
      filter.add('foo');
      filter.add('foo');
      expect(filter.size).toBe(1);
    });
  });

  describe('has', () => {
    it('should return true for values that have been added', () => {
      filter.add('foo');
      expect(filter.has('foo')).toBe(true);
    });

    it('should return false for values that have not been added', () => {
      filter.add('foo');
      filter.add('haz');
      filter.add('lol');
      expect(filter.has('bar')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all values from the filter', () => {
      filter.add('foo');
      filter.add('bar');

      filter.clear();

      expect(filter.has('foo')).toBe(false);
      expect(filter.has('bar')).toBe(false);
    });

    it('should reset the count of added values', () => {
      filter.add('foo');
      filter.add('bar');

      filter.clear();

      expect(filter.size).toBe(0);
    });
  });

  describe('toJSON', () => {
    it('should return the JSON representation of the filter', () => {
      const json = filter.toJSON();
      expect(json.value).toBe('0x0');
      expect(json.m).toBe(1000);
      expect(json.k).toBe(3);
      expect(json.n).toBe(0);
    });
  });

  describe('rate', () => {
    it('should return the false positive rate of the filter', () => {
      for (let i = 0; i < 10000; i++) {
        filter.add(`key${i}`);
        if (i % 100 === 0) {
          const rate = filter.rate;
          expect(rate).toBeGreaterThan(0);
          expect(rate).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});

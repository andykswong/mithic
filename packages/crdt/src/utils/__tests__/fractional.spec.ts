import { beforeEach, describe, expect, it } from '@jest/globals';
import { FractionalIndexGenerator, fractionalIndexToString } from '../fractional.ts';

describe(FractionalIndexGenerator.name, () => {
  let generator: FractionalIndexGenerator;

  beforeEach(() => {
    generator = new FractionalIndexGenerator(() => 0.5);
  });

  describe('create', () => {
    it('should return the correct indices', () => {
      expect([...generator.create(void 0, void 0, 2)]).toEqual(['UUUUUUUU', 'kkkkkkkkUU']);
      expect([...generator.create('AA', 'AZ', 3)]).toEqual(['AMUUUUUUUU', 'ASkkkkkkkkU', 'AVsssssssskUU']);
    });
  });

  describe('validate', () => {
    it('should return true for valid indices', () => {
      expect(generator.validate('AVsssssssskUU')).toBe(true);
    });

    it('should return false for invalid indices', () => {
      expect(generator.validate('+~*0')).toBe(false);
    });
  });
});

describe(fractionalIndexToString.name, () => {
  it('should convert a fractional index array to string', () => {
    expect(fractionalIndexToString([0, 0, 0])).toBe('+++');
    expect(fractionalIndexToString([63, 0, 1])).toBe('z+/');
  });
});

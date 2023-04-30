import { jest } from '@jest/globals';
import { hybridTime } from '../time.js';

describe('hybridTime', () => {
  let nowSpy: jest.SpiedFunction<() => number>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('should return a function which returns the current timestamp', async () => {
    nowSpy.mockReturnValue(123);
    const generator = hybridTime();
    const time = 1234;
    nowSpy.mockReturnValue(time);
    const timestamp = generator();
    expect(timestamp).toBe(time);
  });

  it('should return always increasing timestamp values', () => {
    const now = 1000;
    const generator = hybridTime(() => now);
    const timestamp1 = generator();
    const timestamp2 = generator();
    expect(timestamp1).toBe(now + 1);
    expect(timestamp2).toBe(now + 2);
  });
});

import { jest } from '@jest/globals';
import { atomicHybridTime } from '../time.js';

describe(atomicHybridTime.name, () => {
  let nowSpy: jest.SpiedFunction<() => number>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('should return a function which returns the current timestamp', () => {
    nowSpy.mockReturnValue(100);
    const buffer = new SharedArrayBuffer(8);
    const now = Date.now;
    const result = atomicHybridTime(buffer, now);
    const time = 200;
    nowSpy.mockReturnValue(time);
    const nextTime = result();
    expect(nextTime).toBeGreaterThanOrEqual(time);
  });

  it('should return monotonic increasing values', () => {
    const now = 1000;
    nowSpy.mockReturnValue(now);
    const generator = atomicHybridTime();
    const timestamp1 = generator();
    const timestamp2 = generator();
    expect(timestamp1).toBe(now);
    expect(timestamp2).toBe(now + 1);
  });

  it('should use ref time if it is larger', () => {
    const ref = 2000;
    nowSpy.mockReturnValue(1000);
    const generator = atomicHybridTime();
    const timestamp = generator(ref);
    expect(timestamp).toBe(ref);
  });

  it('should return monotonic increasing values on current usage', () => {
    const buffer = new SharedArrayBuffer(8);
    const now = 1000;
    nowSpy.mockReturnValue(1000);

    const generator1 = atomicHybridTime(buffer);
    const generator2 = atomicHybridTime(buffer);

    const timestamp1 = generator1();
    const timestamp2 = generator2();
    const timestamp3 = generator1();
    expect(timestamp1).toBe(now);
    expect(timestamp2).toBe(now + 1);
    expect(timestamp3).toBe(now + 2);
  });
});

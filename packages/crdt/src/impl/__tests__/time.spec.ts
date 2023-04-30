import { delay } from '@mithic/commons';
import { hybridTime } from '../time.js';

describe('hybridTime', () => {
  it('should return a function which returns the current timestamp', async () => {
    const generator = hybridTime();
    await delay(1);
    const time = Date.now();
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

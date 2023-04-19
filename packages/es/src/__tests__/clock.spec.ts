import { jest } from '@jest/globals';
import { Timestamp, tick } from '../clock.js';

const TIME = 1337 as Timestamp;
const TIME2 = 256 as Timestamp;
const TIME3 = 9999 as Timestamp;

describe('HybridClock', () => {
  describe('tick', () => {
    it('should return current time by default', () => {
      jest.useFakeTimers().setSystemTime(new Date(TIME));
      expect(tick()).toBe(TIME);
    });

    it('should return current time if it is faster', () => {
      jest.useFakeTimers().setSystemTime(new Date(TIME3));
      expect(tick(TIME)).toBe(TIME3);
    });

    it('should advance timestamp by 1 if timestamp equals or is faster than current time', () => {
      jest.useFakeTimers().setSystemTime(new Date(TIME2));
      expect(tick(TIME2)).toBe(TIME2 + 1);
      expect(tick(TIME)).toBe(TIME + 1);
    });
  });
});

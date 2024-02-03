import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SyncMapBatchAdapter } from '../batchmap.ts';
import { OperationError } from '@mithic/commons';

const DATA = [[1, 'value1'], [2, 'value2'], [3, 'value3']] as const;

describe(SyncMapBatchAdapter.name, () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
    for (const [key, value] of DATA) {
      adapter.set(key, value);
    }
  });

  describe('getMany', () => {
    it('should get many values synchronously from the map', () => {
      const keys = DATA.map(([key]) => key);
      const values = [...adapter.getMany(keys)];
      expect(values).toEqual(DATA.map(([, value]) => value));
    });
  });

  describe('hasMany', () => {
    it('should check if it has many values synchronously from the map', () => {
      const keys = [...DATA.map(([key]) => key), 4];
      const values = [...adapter.hasMany(keys)];
      expect(values).toEqual([...DATA.map(() => true), false]);
    });
  });

  describe('setMany', () => {
    it('should set many values synchronously in the map', () => {
      const entries = [[3, 'x'], [4, 'y'], [5, 'z']] as [number, string][];
      const errors = [...adapter.setMany(entries)];
      expect(errors).toEqual([void 0, void 0, void 0]);
      expect(adapter.map.size).toBe(5);
      expect(adapter.map.get(3)).toBe('x');
      expect(adapter.map.get(4)).toBe('y');
      expect(adapter.map.get(5)).toBe('z');
    });

    it('should handle errors while setting many values synchronously in the map', () => {
      const entries = [[1, 'x'], [2, 'y'], [3, 'z']] as [number, string][];
      const error = new Error('failed');
      adapter.set = jest.fn(key => {
        if (key === 2) {
          throw error;
        }
      });
      const errors = [...adapter.setMany(entries)];
      expect(errors).toEqual([
        void 0,
        new OperationError('failed to set value', { detail: 2, cause: error }),
        void 0
      ]);
    });
  });

  describe('deleteMany', () => {
    it('should delete many values synchronously from the map', () => {
      const keys = DATA.map(([key]) => key);
      const errors = [...adapter.deleteMany(keys)];
      expect(errors).toEqual([void 0, void 0, void 0]);
      expect(adapter.map.size).toBe(0);
    });

    it('should handle errors while deleting many values synchronously from the map', () => {
      const keys = [1, 2, 3];
      const error = new Error('failed');
      adapter.delete = jest.fn(key => {
        if (key === 3) {
          throw error;
        }
      });
      const errors = [...adapter.deleteMany(keys)];
      expect(errors).toEqual([
        void 0, void 0,
        new OperationError('failed to delete key', { detail: 3, cause: error }),
      ]);
    });
  });

  describe('updateMany', () => {
    it('should set or delete many values synchronously in the map', () => {
      const entries = [[3, 'x'], [1], [5, 'z']] as [number, string | undefined][];
      const errors = [...adapter.updateMany(entries)];
      expect(errors).toEqual([void 0, void 0, void 0]);
      expect(adapter.map.size).toBe(3);
      expect(adapter.map.get(3)).toBe('x');
      expect(adapter.map.has(1)).toBe(false);
      expect(adapter.map.get(5)).toBe('z');
    });

    it('should handle errors while setting many values synchronously in the map', () => {
      const entries = [[1, 'x'], [2], [3, 'z']] as [number, string | undefined][];
      const error = new Error('failed');
      adapter.set = jest.fn(key => {
        if (key === 3) {
          throw error;
        }
      });
      const errors = [...adapter.updateMany(entries)];
      expect(errors).toEqual([
        void 0,
        void 0,
        new OperationError('failed to update key', { detail: 3, cause: error }),
      ]);
    });
  });

});

class TestAdapter extends SyncMapBatchAdapter<number, string> {
  map = new Map<number, string>();

  delete(key: number): void {
    this.map.delete(key);
  }

  get(key: number): string | undefined {
    return this.map.get(key);
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  set(key: number, value: string): void {
    this.map.set(key, value);
  }
}

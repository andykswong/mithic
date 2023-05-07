import { jest } from '@jest/globals';
import { ErrorCode, operationError } from '@mithic/commons';
import { SyncMapBatchAdapter } from '../batchmap.js';

const DATA = [[1, 'value1'], [2, 'value2'], [3, 'value3']] as const;

describe(SyncMapBatchAdapter.name, () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
    for (const [key, value] of DATA) {
      adapter.set(key, value);
    }
  });

  it('should get many values synchronously from the map', () => {
    const keys = DATA.map(([key]) => key);
    const values = [...adapter.getMany(keys)];
    expect(values).toEqual(DATA.map(([, value]) => value));
  });

  it('should check if it has many values synchronously from the map', () => {
    const keys = [...DATA.map(([key]) => key), 4];
    const values = [...adapter.hasMany(keys)];
    expect(values).toEqual([...DATA.map(() => true), false]);
  });

  it('should set many values synchronously in the map', () => {
    const entries = [[3, 'x'], [4, 'y'], [5, 'z']] as Iterable<[number, string]>;
    const errors = [...adapter.setMany(entries)];
    expect(errors).toEqual([void 0, void 0, void 0]);
    expect(adapter.map.size).toBe(5);
  });

  it('should handle errors while setting many values synchronously in the map', () => {
    const entries = [[1, 'x'], [2, 'y'], [3, 'z']] as Iterable<[number, string]>;
    const error = new Error('Failed');
    adapter.set = jest.fn(key => {
      if (key === 2) {
        throw error;
      }
    });
    const errors = [...adapter.setMany(entries)];
    expect(errors).toEqual([
      void 0,
      operationError('Failed to set value', ErrorCode.OpFailed, 2, error),
      void 0
    ]);
  });

  it('should delete many values synchronously from the map', () => {
    const keys = DATA.map(([key]) => key);
    const errors = [...adapter.deleteMany(keys)];
    expect(errors).toEqual([void 0, void 0, void 0]);
    expect(adapter.map.size).toBe(0);
  });

  it('should handle errors while deleting many values synchronously from the map', () => {
    const keys = [1, 2, 3];
    const error = new Error('Failed');
    adapter.delete = jest.fn(key => {
      if (key === 3) {
        throw error;
      }
    });
    const errors = [...adapter.deleteMany(keys)];
    expect(errors).toEqual([
      void 0, void 0,
      operationError('Failed to delete key', ErrorCode.OpFailed, 3, error),
    ]);
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
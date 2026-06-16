import { expect, test } from 'vitest';
import { selectBackend } from './select.ts';

test('preferred backend wins when available', () => {
  expect(selectBackend({ preferred: 'iframe' }, { available: ['iframe', 'worker'] })).toBe('iframe');
});

test('falls back through fallbackOrder', () => {
  expect(selectBackend({ preferred: 'iframe', fallbackOrder: ['quickjs', 'worker'] }, { available: ['worker'] })).toBe('worker');
});

test('requirements filter unsuitable backends (gui needs iframe)', () => {
  expect(selectBackend({ requirements: { gui: true } }, { available: ['quickjs', 'worker', 'iframe'] })).toBe('iframe');
});

test('throws when nothing satisfies requirements', () => {
  expect(() => selectBackend({ requirements: { gui: true } }, { available: ['quickjs', 'worker'] })).toThrow();
});

test('preferred backend is skipped if it does not meet requirements', () => {
  // worker has no gui, so should fall through to iframe
  expect(selectBackend({ preferred: 'worker', requirements: { gui: true } }, { available: ['worker', 'iframe'] })).toBe('iframe');
});

test('falls back when preferred is unavailable', () => {
  expect(selectBackend({ preferred: 'quickjs', fallbackOrder: ['worker'] }, { available: ['worker'] })).toBe('worker');
});

test('default fallback order is worker first when no preferred and no requirements', () => {
  expect(selectBackend({}, { available: ['ivm', 'worker', 'iframe'] })).toBe('worker');
});

test('throws when available list is empty', () => {
  expect(() => selectBackend({}, { available: [] })).toThrow();
});

test('deterministic requirement selects quickjs', () => {
  expect(selectBackend({ requirements: { deterministic: true } }, { available: ['worker', 'iframe', 'quickjs', 'ivm'] })).toBe('quickjs');
});

test('memoryLimit requirement excludes worker and iframe', () => {
  const result = selectBackend({ requirements: { memoryLimit: true } }, { available: ['worker', 'iframe', 'quickjs', 'ivm'] });
  expect(['quickjs', 'ivm']).toContain(result);
});

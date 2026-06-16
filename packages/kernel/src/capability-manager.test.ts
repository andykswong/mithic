import { expect, test } from 'vitest';
import { CapabilityManager } from './capability-manager.ts';

test('grants fs read on an allowed prefix, denies outside', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read', 'write'] }]);
  expect(cm.checkFs(1, '/tmp/x', 'read')).toBe(true);
  expect(cm.checkFs(1, '/etc/passwd', 'read')).toBe(false);
});

test('write requires write operation grant', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(cm.checkFs(1, '/tmp/x', 'write')).toBe(false);
});

test('children can only narrow, never widen, parent caps', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp', '/home'], operations: ['read', 'write'] }]);
  const childCaps = cm.narrow(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(childCaps).toEqual([{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(() => cm.narrow(1, [{ type: 'fs', paths: ['/root'], operations: ['read'] }])).toThrow();
});

test('net check matches origins', () => {
  const cm = new CapabilityManager();
  cm.grant(2, [{ type: 'net', origins: ['https://api.example.com'] }]);
  expect(cm.checkNet(2, 'https://api.example.com/x')).toBe(true);
  expect(cm.checkNet(2, 'https://evil.com')).toBe(false);
});

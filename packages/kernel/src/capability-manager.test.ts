import { expect, test } from 'vitest';
import { CapabilityManager } from './capability-manager.ts';

test('checkProcess: true only when a process cap is held', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'process' }]);
  cm.grant(2, [{ type: 'fs', paths: ['/'], operations: ['read'] }]);
  expect(cm.checkProcess(1)).toBe(true);
  expect(cm.checkProcess(2)).toBe(false);
  expect(cm.checkProcess(99)).toBe(false);
});

test('checkProcess honors maxChildren when a current child count is supplied', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'process', maxChildren: 2 }]);
  expect(cm.checkProcess(1, 0)).toBe(true);
  expect(cm.checkProcess(1, 1)).toBe(true);
  expect(cm.checkProcess(1, 2)).toBe(false);
  // No maxChildren = unlimited.
  cm.grant(2, [{ type: 'process' }]);
  expect(cm.checkProcess(2, 1000)).toBe(true);
});

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

// Fix 3: checkFs must collapse .. and . before prefix matching
test('checkFs collapses .. — /tmp/../etc/passwd is denied with only /tmp grant', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(cm.checkFs(1, '/tmp/../etc/passwd', 'read')).toBe(false);
});

test('checkFs collapses . — /tmp/./sub is allowed with /tmp grant', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(cm.checkFs(1, '/tmp/./sub', 'read')).toBe(true);
});

// Fix 4: adversarial capability tests
test('checkFs rejects prefix-escape siblings — /tmp grant does not authorize /tmp2/x or /tmpevil', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/tmp'], operations: ['read'] }]);
  expect(cm.checkFs(1, '/tmp2/x', 'read')).toBe(false);
  expect(cm.checkFs(1, '/tmpevil', 'read')).toBe(false);
  expect(cm.checkFs(1, '/tmp', 'read')).toBe(true);
  expect(cm.checkFs(1, '/tmp/safe', 'read')).toBe(true);
});

test('narrow rejects widening operation: parent read-only, child requests read+write', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'fs', paths: ['/a'], operations: ['read'] }]);
  expect(() =>
    cm.narrow(1, [{ type: 'fs', paths: ['/a'], operations: ['read', 'write'] }]),
  ).toThrow();
});

test('narrow rejects widening maxChildren beyond parent limit', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'process', maxChildren: 2 }]);
  expect(() =>
    cm.narrow(1, [{ type: 'process', maxChildren: 10 }]),
  ).toThrow();
});

test('narrow rejects widening maxChildren to unlimited when parent has a limit', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'process', maxChildren: 2 }]);
  // undefined = unlimited — must be rejected since parent is capped at 2
  expect(() =>
    cm.narrow(1, [{ type: 'process', maxChildren: undefined }]),
  ).toThrow();
});

test('narrow rejects a foreign ipc channel not in parent grant', () => {
  const cm = new CapabilityManager();
  cm.grant(1, [{ type: 'ipc', channels: ['allowed-channel'] }]);
  expect(() =>
    cm.narrow(1, [{ type: 'ipc', channels: ['allowed-channel', 'evil-channel'] }]),
  ).toThrow();
});

import { describe, it } from 'node:test';

describe('OPFSProvider', { skip: typeof globalThis.navigator === 'undefined' }, () => {
  // OPFS is only available in browser/worker environments.
  // These tests would run in a browser test runner.
  it.todo('create file and read back');
  it.todo('mkdir and readdir');
  it.todo('stat returns correct size and type');
  it.todo('rename file');
  it.todo('unlink file');
  it.todo('throws not-supported for symlink');
  it.todo('throws not-supported for chmod');
  it.todo('throws not-supported for link');
});

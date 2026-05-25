import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDirectories,
  _setPreopens,
  _addPreopen,
  _clearPreopens,
  _setFileData,
  _getFileData,
} from './preopens.ts';
import { Descriptor, type FileData } from './types.ts';

describe('preopens', () => {
  it('default preopens has one root entry [Descriptor, "/"]', () => {
    // Reset to default state
    _setFileData({ dir: {} });
    const dirs = getDirectories();
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0][0] instanceof Descriptor);
    assert.equal(dirs[0][1], '/');
  });

  it('getDirectories() returns array of [Descriptor, string] tuples', () => {
    _setFileData({ dir: {} });
    const dirs = getDirectories();
    assert.ok(Array.isArray(dirs));
    for (const [desc, path] of dirs) {
      assert.ok(desc instanceof Descriptor);
      assert.equal(typeof path, 'string');
    }
  });

  it('_setPreopens replaces all preopens', () => {
    const fsA: FileData = { dir: { 'a.txt': { source: 'aaa' } } };
    const fsB: FileData = { dir: { 'b.txt': { source: 'bbb' } } };
    _setPreopens({ '/home': fsA, '/tmp': fsB });

    const dirs = getDirectories();
    assert.equal(dirs.length, 2);
    const paths = dirs.map(([, p]) => p);
    assert.ok(paths.includes('/home'));
    assert.ok(paths.includes('/tmp'));
  });

  it('_addPreopen adds to existing preopens', () => {
    _setFileData({ dir: {} });
    const initialCount = getDirectories().length;
    _addPreopen('/data', { dir: { 'file.txt': { source: 'data' } } });
    const dirs = getDirectories();
    assert.equal(dirs.length, initialCount + 1);
    const last = dirs[dirs.length - 1];
    assert.equal(last[1], '/data');
    assert.ok(last[0] instanceof Descriptor);
  });

  it('_clearPreopens removes all preopens', () => {
    _setFileData({ dir: {} });
    assert.ok(getDirectories().length > 0);
    _clearPreopens();
    assert.equal(getDirectories().length, 0);
  });

  it('_setFileData resets to single root preopen', () => {
    _clearPreopens();
    assert.equal(getDirectories().length, 0);

    const newFs: FileData = { dir: { 'test.txt': { source: 'hello' } } };
    _setFileData(newFs);

    const dirs = getDirectories();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0][1], '/');
    assert.ok(dirs[0][0] instanceof Descriptor);
  });

  it('_getFileData returns current file data', () => {
    const testFs: FileData = { dir: { 'x.txt': { source: 'x' } } };
    _setFileData(testFs);
    const result = _getFileData();
    assert.equal(result, testFs);
  });

  it('_addPreopen with "/" updates root preopen and file data', () => {
    _clearPreopens();
    const rootFs: FileData = { dir: { 'root.txt': { source: 'root' } } };
    _addPreopen('/', rootFs);
    const data = _getFileData();
    assert.equal(data, rootFs);
    const dirs = getDirectories();
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0][1], '/');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessTable } from './simple.ts';
import { Process, type ProcessHandler } from '../types.ts';

function makeStubProcess(pid: number): Process {
  const handler: ProcessHandler = {
    wait: () => Promise.resolve(0),
  };
  return new Process(pid, handler);
}

describe('ProcessTable', () => {
  it('allocPid returns incrementing IDs', () => {
    const table = new ProcessTable();
    assert.equal(table.allocPid(), 1);
    assert.equal(table.allocPid(), 2);
    assert.equal(table.allocPid(), 3);
  });

  it('register and get lifecycle', () => {
    const table = new ProcessTable();
    const pid = table.allocPid();
    const entry = {
      pid,
      command: 'echo',
      args: ['hello'],
      cwd: '/',
      startTime: new Date(),
      process: makeStubProcess(pid),
    };
    table.register(pid, entry);
    assert.deepEqual(table.get(pid), entry);
  });

  it('get returns undefined for unknown pid', () => {
    const table = new ProcessTable();
    assert.equal(table.get(999), undefined);
  });

  it('remove deletes process entry', () => {
    const table = new ProcessTable();
    const pid = table.allocPid();
    table.register(pid, {
      pid,
      command: 'test',
      args: [],
      cwd: '/',
      startTime: new Date(),
      process: makeStubProcess(pid),
    });
    assert.equal(table.remove(pid), true);
    assert.equal(table.get(pid), undefined);
    assert.equal(table.remove(pid), false);
  });

  it('list returns all processes', () => {
    const table = new ProcessTable();
    const pid1 = table.allocPid();
    const pid2 = table.allocPid();
    const entry1 = { pid: pid1, command: 'a', args: [] as string[], cwd: '/', startTime: new Date(), process: makeStubProcess(pid1) };
    const entry2 = { pid: pid2, command: 'b', args: [] as string[], cwd: '/', startTime: new Date(), process: makeStubProcess(pid2) };
    table.register(pid1, entry1);
    table.register(pid2, entry2);
    const list = table.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], entry1);
    assert.deepEqual(list[1], entry2);
  });

  it('size reflects count', () => {
    const table = new ProcessTable();
    assert.equal(table.size, 0);
    const pid = table.allocPid();
    table.register(pid, { pid, command: 'x', args: [], cwd: '/', startTime: new Date(), process: makeStubProcess(pid) });
    assert.equal(table.size, 1);
    table.remove(pid);
    assert.equal(table.size, 0);
  });
});

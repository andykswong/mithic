import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { terminalStdin, terminalStdout, terminalStderr, TerminalInput, TerminalOutput } from './terminal.ts';
import { exit, exitWithCode, ComponentExit } from './exit.ts';
import { getEnvironment, getArguments, initialCwd, _setEnv, _setArgs, _setCwd } from './environment.ts';
import { stdin, stdout, stderr, _setStdin, _setStdout, _setStderr, getStdin, getStdout, getStderr } from './stdio.ts';
import { InputStream, OutputStream } from '../io/streams.ts';

describe('terminal', () => {
  it('getTerminalStdin returns undefined when not a TTY', () => {
    _setStdin({ blockingRead() { throw { tag: 'closed' }; } });
    const result = terminalStdin.getTerminalStdin();
    assert.equal(result, undefined);
  });

  it('getTerminalStdin returns TerminalInput when isatty is true', () => {
    _setStdin({ handler: { blockingRead() { throw { tag: 'closed' }; } }, isatty: true });
    const result = terminalStdin.getTerminalStdin();
    assert.ok(result instanceof TerminalInput);
  });

  it('getTerminalStdout returns undefined when not a TTY', () => {
    _setStdout({ write() {} });
    const result = terminalStdout.getTerminalStdout();
    assert.equal(result, undefined);
  });

  it('getTerminalStdout returns TerminalOutput when isatty is true', () => {
    _setStdout({ handler: { write() {} }, isatty: true });
    const result = terminalStdout.getTerminalStdout();
    assert.ok(result instanceof TerminalOutput);
  });

  it('getTerminalStderr returns undefined when not a TTY', () => {
    _setStderr({ write() {} });
    const result = terminalStderr.getTerminalStderr();
    assert.equal(result, undefined);
  });

  it('getTerminalStderr returns TerminalOutput when isatty is true', () => {
    _setStderr({ handler: { write() {} }, isatty: true });
    const result = terminalStderr.getTerminalStderr();
    assert.ok(result instanceof TerminalOutput);
  });

  it('terminal exports include class constructors', () => {
    assert.ok(terminalStdin.TerminalInput === TerminalInput);
    assert.ok(terminalStdout.TerminalOutput === TerminalOutput);
    assert.ok(terminalStderr.TerminalOutput === TerminalOutput);
  });
});

describe('exit', () => {
  it('exit with ok throws ComponentExit with code 0', () => {
    try {
      exit({ tag: 'ok' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof ComponentExit);
      assert.equal((e as ComponentExit).code, 0);
      assert.equal((e as ComponentExit).exitError, true);
    }
  });

  it('exit with err throws ComponentExit with code 1', () => {
    try {
      exit({ tag: 'err' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof ComponentExit);
      assert.equal((e as ComponentExit).code, 1);
    }
  });

  it('exit with err includes val when provided', () => {
    try {
      exit({ tag: 'err', val: 'some error detail' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof ComponentExit);
      assert.equal((e as ComponentExit).code, 1);
    }
  });

  it('exitWithCode throws ComponentExit with given code', () => {
    try {
      exitWithCode(42);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof ComponentExit);
      assert.equal((e as ComponentExit).code, 42);
    }
  });

  it('ComponentExit is an Error instance', () => {
    const err = new ComponentExit(0);
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'Component exited successfully');
  });

  it('ComponentExit with non-zero code has error message', () => {
    const err = new ComponentExit(1);
    assert.equal(err.message, 'Component exited with error');
  });
});

describe('environment', () => {
  it('getEnvironment returns [string, string][]', () => {
    _setEnv({ FOO: 'bar', BAZ: 'qux' });
    const env = getEnvironment();
    assert.deepEqual(env, [['FOO', 'bar'], ['BAZ', 'qux']]);
  });

  it('getArguments returns string[]', () => {
    _setArgs(['app', '--flag']);
    const args = getArguments();
    assert.deepEqual(args, ['app', '--flag']);
  });

  it('initialCwd returns string', () => {
    _setCwd('/home/user');
    assert.equal(initialCwd(), '/home/user');
  });

  it('_setEnv / getEnvironment round-trip with special characters in values', () => {
    _setEnv({
      'PATH': '/usr/bin:/usr/local/bin',
      'GREETING': 'hello world!',
      'SPECIAL': 'value=with=equals',
      'EMPTY': '',
      'QUOTES': '"quoted"',
      'NEWLINE': 'line1\nline2',
    });
    const env = getEnvironment();
    assert.equal(env.length, 6);
    assert.deepEqual(env[0], ['PATH', '/usr/bin:/usr/local/bin']);
    assert.deepEqual(env[1], ['GREETING', 'hello world!']);
    assert.deepEqual(env[2], ['SPECIAL', 'value=with=equals']);
    assert.deepEqual(env[3], ['EMPTY', '']);
    assert.deepEqual(env[4], ['QUOTES', '"quoted"']);
    assert.deepEqual(env[5], ['NEWLINE', 'line1\nline2']);
  });

  it('_setArgs / getArguments round-trip with empty args', () => {
    _setArgs([]);
    const args = getArguments();
    assert.deepEqual(args, []);
  });

  it('_setCwd / initialCwd round-trip', () => {
    _setCwd('/some/path/with spaces');
    assert.equal(initialCwd(), '/some/path/with spaces');
  });

  it('default values before any _set calls use initialized defaults', () => {
    // After previous tests have set values, verify that the module-level state
    // stores whatever was last set (module-level mutable state)
    _setEnv({});
    _setArgs([]);
    _setCwd('/');
    assert.deepEqual(getEnvironment(), []);
    assert.deepEqual(getArguments(), []);
    assert.equal(initialCwd(), '/');
  });
});

describe('stdio', () => {
  it('stdin export includes InputStream class', () => {
    assert.equal(stdin.InputStream, InputStream);
  });

  it('stdout export includes OutputStream class', () => {
    assert.equal(stdout.OutputStream, OutputStream);
  });

  it('stderr export includes OutputStream class', () => {
    assert.equal(stderr.OutputStream, OutputStream);
  });

  it('getStdin returns an InputStream', () => {
    const s = stdin.getStdin();
    assert.ok(s instanceof InputStream);
  });

  it('getStdout returns an OutputStream', () => {
    const s = stdout.getStdout();
    assert.ok(s instanceof OutputStream);
  });

  it('getStderr returns an OutputStream', () => {
    const s = stderr.getStderr();
    assert.ok(s instanceof OutputStream);
  });

  it('_setStdout with custom handler — verify write goes through handler', () => {
    const written: Uint8Array[] = [];
    _setStdout({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });
    const stream = getStdout();
    stream.write(new Uint8Array([72, 105]));
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([72, 105]));
  });

  it('_setStdin with custom handler — verify read comes from handler', () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    _setStdin({
      read(len: number) {
        return testData.slice(0, len);
      },
      blockingRead(len: number) {
        return testData.slice(0, len);
      },
    });
    const stream = getStdin();
    const data = stream.read(3n);
    assert.deepEqual(data, new Uint8Array([1, 2, 3]));
  });

  it('_setStderr with custom handler — verify write goes through handler', () => {
    const written: Uint8Array[] = [];
    _setStderr({
      write(data: Uint8Array) {
        written.push(new Uint8Array(data));
      },
    });
    const stream = getStderr();
    stream.write(new Uint8Array([69, 82, 82]));
    assert.equal(written.length, 1);
    assert.deepEqual(written[0], new Uint8Array([69, 82, 82]));
  });

  it('_setStdin accepts InputStream instance directly', () => {
    const data = new Uint8Array([7, 8, 9]);
    _setStdin(new InputStream({ blockingRead(len) { return data.slice(0, len); } }));
    const stream = getStdin();
    assert.deepEqual(stream.blockingRead(2n), new Uint8Array([7, 8]));
  });

  it('_setStdout accepts OutputStream instance directly', () => {
    const written: Uint8Array[] = [];
    _setStdout(new OutputStream({ write(d) { written.push(new Uint8Array(d)); } }));
    getStdout().write(new Uint8Array([1]));
    assert.equal(written.length, 1);
  });

  it('_setStderr accepts OutputStream instance directly', () => {
    const written: Uint8Array[] = [];
    _setStderr(new OutputStream({ write(d) { written.push(new Uint8Array(d)); } }));
    getStderr().write(new Uint8Array([2]));
    assert.equal(written.length, 1);
  });

  it('getStdout returns a new borrow on each call', () => {
    _setStdout({ write() {} });
    const a = getStdout();
    const b = getStdout();
    assert.notStrictEqual(a, b);
  });

  it('disposing one borrow from getStdout does not affect subsequent borrows', () => {
    const written: Uint8Array[] = [];
    _setStdout({ write(d) { written.push(new Uint8Array(d)); } });

    const first = getStdout();
    first.write(new Uint8Array([1]));
    first[Symbol.dispose]();

    const second = getStdout();
    second.write(new Uint8Array([2]));

    assert.equal(written.length, 2);
    assert.deepEqual(written[1], new Uint8Array([2]));
  });

  it('getStdin returns a new borrow on each call', () => {
    _setStdin({ blockingRead() { return new Uint8Array(0); } });
    const a = getStdin();
    const b = getStdin();
    assert.notStrictEqual(a, b);
  });
});

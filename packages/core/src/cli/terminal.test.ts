import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TerminalInput } from './terminal-input.ts';
import { TerminalOutput } from './terminal-output.ts';
import { terminalStdin, terminalStdout, terminalStderr } from './index.ts';

describe('terminal', () => {
  describe('getTerminalStdin', () => {
    it('should return a TerminalInput instance', () => {
      const stdin = terminalStdin.getTerminalStdin();
      assert(stdin instanceof TerminalInput);
      assert.strictEqual(`${stdin}`, '[object TerminalInput]');
    });
  });

  describe('getTerminalStdout', () => {
    it('should return a TerminalOutput instance', () => {
      const stdout = terminalStdout.getTerminalStdout();
      assert(stdout instanceof TerminalOutput);
      assert.strictEqual(stdout.isErr, false);
      assert.strictEqual(`${stdout}`, '[object TerminalOutput]');
    });
  });

  describe('getTerminalStderr', () => {
    it('should return a TerminalOutput instance', () => {
      const stderr = terminalStderr.getTerminalStderr();
      assert(stderr instanceof TerminalOutput);
      assert.strictEqual(stderr.isErr, true);
    });
  });
});

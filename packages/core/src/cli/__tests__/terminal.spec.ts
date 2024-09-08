import { describe, expect, it } from '@jest/globals';
import { getTerminalStdin } from '../terminal-stdin.ts';
import { TerminalInput } from '../terminal-input.ts';
import { getTerminalStdout } from '../terminal-stdout.ts';
import { TerminalOutput } from '../terminal-output.ts';
import { getTerminalStderr } from '../terminal-stderr.ts';

describe('getTerminalStdin', () => {
  it('should return a TerminalInput instance', () => {
    const stdin = getTerminalStdin();
    expect(stdin).toBeInstanceOf(TerminalInput);
    expect(`${stdin}`).toBe('[object TerminalInput]');
  });
});

describe('getTerminalStdout', () => {
  it('should return a TerminalOutput instance', () => {
    const stdout = getTerminalStdout();
    expect(stdout).toBeInstanceOf(TerminalOutput);
    expect(stdout.isErr).toBe(false);
    expect(`${stdout}`).toBe('[object TerminalOutput]');
  });
});

describe('getTerminalStderr', () => {
  it('should return a TerminalOutput instance', () => {
    const stdout = getTerminalStderr();
    expect(stdout).toBeInstanceOf(TerminalOutput);
    expect(stdout.isErr).toBe(true);
  });
});

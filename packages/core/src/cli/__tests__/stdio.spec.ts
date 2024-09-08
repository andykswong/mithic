import { describe, expect, it } from '@jest/globals';
import { InputStream, OutputStream } from '../../io/streams.ts';
import { FD } from '../../types.ts';
import { getStdin } from '../stdin.ts';
import { getStdout } from '../stdout.ts';
import { getStderr } from '../stderr.ts';

describe('stdio', () => {
  describe('getStdin', () => {
    it('should return an InputStream instance with fd = 0', () => {
      const stdin = getStdin();
      expect(stdin).toBeInstanceOf(InputStream);
      expect(stdin.fd).toBe(FD.Stdin);
    });
  });

  describe('getStdout', () => {
    it('should return an OutputStream instance with fd = 1', () => {
      const stdout = getStdout();
      expect(stdout).toBeInstanceOf(OutputStream);
      expect(stdout.fd).toBe(FD.Stdout);
    });
  });

  describe('getStderr', () => {
    it('should return an OutputStream instance with fd = 2', () => {
      const stderr = getStderr();
      expect(stderr).toBeInstanceOf(OutputStream);
      expect(stderr.fd).toBe(FD.Stderr);
    });
  });
});

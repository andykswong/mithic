import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InputStream, OutputStream } from '../io/streams.ts';
import { FD } from '../index.ts';
import { stdin, stdout, stderr } from './index.ts';

describe('stdio', () => {
  describe('getStdin', () => {
    it('should return an InputStream instance with fd = 0', () => {
      const stream = stdin.getStdin();
      assert(stream instanceof InputStream);
      assert.strictEqual(stream.fd, FD.Stdin);
    });
  });

  describe('getStdout', () => {
    it('should return an OutputStream instance with fd = 1', () => {
      const stream = stdout.getStdout();
      assert(stream instanceof OutputStream);
      assert.strictEqual(stream.fd, FD.Stdout);
    });
  });

  describe('getStderr', () => {
    it('should return an OutputStream instance with fd = 2', () => {
      const stream = stderr.getStderr();
      assert(stream instanceof OutputStream);
      assert.strictEqual(stream.fd, FD.Stderr);
    });
  });
});

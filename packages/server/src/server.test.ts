/**
 * @mithic/server — POST /exec integration tests
 *
 * Uses Hono's `app.request()` (no real TCP socket) to drive the HTTP handler.
 * Guest code uses the QuickJS relay protocol (`__isola_syscall` directly).
 *
 * ## Backend: QuickJS
 * All tests use the QuickJS relay backend (default for @mithic/server) because:
 *   - It enforces `timeoutMs` deterministically via the WASM interrupt handler.
 *   - No Worker / SharedArrayBuffer needed — works in the vitest Node env.
 *
 * ## Timeout test
 * The timeout test passes `limits.timeoutMs: 500` and runs an infinite loop.
 * QuickJS's interrupt handler fires every ~INTERRUPT_OP_INTERVAL opcodes and
 * checks the wall-clock deadline, throwing `InternalError: interrupted`.
 * The relay launcher catches the exit (code 1) and calls `ctx.notifyExit(1)`.
 * The server returns `{ exitCode: 1, limitHit: true }`.
 */

import { describe, expect, test } from 'vitest';
import { createApp } from './server.ts';
import type { ExecResponse } from './server.ts';

// Generous timeout for QuickJS WASM module initialisation.
const SUITE_TIMEOUT = 30_000;

describe('POST /exec', () => {
  test('happy path: guest writes to stdout, exits 0', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `
          __isola_syscall('pipe/write', { fd: 1, data: 'hello from server\\n' });
          __isola_syscall('process/exit', { code: 0 });
        `,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as ExecResponse;
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe('hello from server\n');
    expect(body.limitHit).toBe(false);
  }, SUITE_TIMEOUT);

  test('env vars are forwarded to the guest', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `
          const env = __isola_init.env;
          __isola_syscall('pipe/write', { fd: 1, data: env.GREETING });
          __isola_syscall('process/exit', { code: 0 });
        `,
        env: { GREETING: 'howdy' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as ExecResponse;
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe('howdy');
  }, SUITE_TIMEOUT);

  test('guest non-zero exit is reflected in exitCode', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `
          __isola_syscall('pipe/write', { fd: 2, data: 'fail' });
          __isola_syscall('process/exit', { code: 42 });
        `,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as ExecResponse;
    expect(body.exitCode).toBe(42);
    expect(body.stderr).toBe('fail');
    expect(body.limitHit).toBe(false);
  }, SUITE_TIMEOUT);

  test('timeoutMs: infinite loop is killed, limitHit=true, non-zero exit', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: `
          // Tight infinite loop — QuickJS interrupt handler will abort this
          // when the timeoutMs wall-clock deadline is exceeded.
          while (true) {}
        `,
        limits: { timeoutMs: 500 },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as ExecResponse;
    // QuickJS interrupt handler exits with code 1 (InternalError: interrupted).
    expect(body.exitCode).not.toBe(0);
    expect(body.limitHit).toBe(true);
  }, SUITE_TIMEOUT);

  test('400 on missing code field', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: {} }),
    });

    expect(res.status).toBe(400);
  }, SUITE_TIMEOUT);

  test('400 on invalid JSON', async () => {
    const app = createApp();

    const res = await app.request('/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
  }, SUITE_TIMEOUT);
});

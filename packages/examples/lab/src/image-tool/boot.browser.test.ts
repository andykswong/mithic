/**
 * Task V5+ (injectable runtime backend). {@link createLab} accepts an optional
 * runtime parameter, defaulting to {@link WorkerRuntime} for backward compatibility.
 * Callers (e.g., image-tool product page) can inject an {@link IframeRuntime} to
 * run guests as visible GUI guests that paint their own preview. This test verifies
 * both the default and injected paths work end-to-end.
 */
import { afterEach, expect, test } from 'vitest';
import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';

const T = 20000;
let lab: Lab | undefined;
afterEach(() => { lab?.dispose(); lab = undefined; });

test('createLab defaults to a working runtime (backward-compatible) and runs a command', async () => {
  lab = await createLab({ persistStorage: null });
  const out = await lab.run('echo hi');
  expect(out).toContain('hi');
}, T);

test('createLab accepts an injected IframeRuntime and still runs a command', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  lab = await createLab({ persistStorage: null, runtime: new IframeRuntime({ container }) });
  const out = await lab.run('echo iframe-ok');
  expect(out).toContain('iframe-ok');
  container.remove();
}, T);

/**
 * Test fixture: a utility that attempts a `net/fetch` and reports the outcome on
 * stdout. Installed with a manifest that grants only `fs` (no `net`), it proves
 * the kernel DENIES an undeclared capability at runtime — the guest sees
 * `EACCES`, never reaches the network.
 *
 *   netprobe        # writes 'NET-DENIED:<errno>' or 'OK' to stdout
 *
 * Authored on `@mithic/guest-runtime` like a real utility so the `?bundle`
 * plugin produces the same exec-from-VFS-runnable form the Lab installs.
 */
import { createGuest } from '@mithic/guest-runtime';

export default async (boot: unknown): Promise<void> => {
  const g = createGuest(boot as Parameters<typeof createGuest>[0]);
  const w = g.stdout.getWriter();
  let result = 'OK';
  try {
    await g.syscall('net/fetch', { method: 'GET', url: 'https://example.com/' });
  } catch (e) {
    const err = e as { code?: string; errno?: string; message?: string };
    result = 'NET-DENIED:' + (err.code ?? err.errno ?? err.message ?? 'unknown');
  }
  await w.write(new TextEncoder().encode(result));
  await w.close().catch(() => {});
  g.exit(0);
};

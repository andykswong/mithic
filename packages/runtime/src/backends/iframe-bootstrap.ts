/**
 * Opaque-origin guest sandbox CSP (see spec §3.3/§5). This is DELIBERATELY permissive
 * for code execution ('unsafe-inline' 'unsafe-eval') — isolation here comes from the
 * opaque origin + postMessage-only egress, NOT from script-src. Do not "harden" this
 * into a general-web XSS policy. Rules:
 *  - img/media/font-src take blob: AND data: (passive, guest-produced assets, local only —
 *    NO remote origins: a remote asset GET is an exfil channel connect-src cannot stop, §9 rule 2).
 *  - connect-src 'none' blocks fetch/XHR/WebSocket/EventSource/sendBeacon/<a ping> — network is
 *    the net/fetch syscall, not the guest (§3.4).
 *  - form-action/base-uri 'none' are belt-and-suspenders; navigation/popup/form egress is closed
 *    PRIMARILY by the sandbox="allow-scripts" attribute (no allow-forms/allow-popups/
 *    allow-top-navigation). ANY future sandbox-flag addition must re-run the §3.4 threat model.
 *  - webrtc 'block' is DECLARED but NOT enforced by shipping browsers (CSP3 "Other Directive") —
 *    the REAL WebRTC control is the RTCPeerConnection/RTCDataChannel shim below (Task A2).
 *  - worker-src 'none' is EXPLICIT (OF1) — it blocks nested Worker/SharedWorker/ServiceWorker.
 *    worker-src does NOT fall back to default-src: absent, it falls back child-src -> script-src
 *    -> default-src (CSP3, MDN verified 2026-07-04). Once script-src gained blob: (below), an
 *    ABSENT worker-src would inherit blob: and permit new Worker(blob:) — reopening the nested-
 *    worker vector §3.4 closes. Pinning worker-src 'none' here severs that fallback. Do NOT drop it.
 *  - script-src does NOT get data: (ever).
 *  - script-src ALSO gets blob: (OF1) — await import(blobUrl) is a SCRIPT FETCH governed by
 *    script-src, NOT covered by 'unsafe-eval' (MDN, verified 2026-07-04). Removing blob: here
 *    silently breaks OF1 (the guest module can't load). This is NO NEW AUTHORITY: the iframe
 *    already runs 'unsafe-inline' 'unsafe-eval' and is opaque-origin, so a blob: it mints is
 *    same-origin to THIS iframe only (§3.2/§3.3). Do not "harden" it away.
 *
 * This is the DEFAULT applied when a spawn supplies no per-guest `csp`. G6-CSP-manifest
 * (spec §9) lets the host pass a manifest-compiled CSP into {@link buildSrcdoc}; that
 * compiled policy MUST preserve this directive set's invariants (see @mithic/desktop
 * manifestCsp) — most critically worker-src 'none' and connect-src 'none'.
 */
export const DEFAULT_GUEST_CSP = 'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src \'none\'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src \'unsafe-inline\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; webrtc \'block\'';

/**
 * Builds an HTML srcdoc string for use as an iframe's srcdoc attribute.
 *
 * The resulting document:
 *  - Has a locked-down CSP (`csp`, defaulting to {@link DEFAULT_GUEST_CSP}) that allows only
 *    inline scripts/styles (no external fetches)
 *  - Runs an inline module script that implements the same __mithic_init / __mithic_run
 *    bootstrap protocol as worker.ts BOOTSTRAP_SOURCE, but over window.postMessage
 *    with the opener/parent as the host
 *  - Reconstructs the boot object: { control, init, preopenPorts, imports }
 *  - Calls the guest module's default export with the boot object
 *
 * @param csp The Content-Security-Policy for the iframe (G6-CSP-manifest §9). Defaults to
 *   {@link DEFAULT_GUEST_CSP}; a host compiles a per-guest policy from its manifest.
 *
 * Protocol (same as WorkerRuntime):
 *  1. Host sends { __mithic_init: ProcessInit, ports: Transferable[] } with a transfer list.
 *     ports[0] = control MessagePort, ports[1..] = stdio MessagePorts.
 *  2. Host sends { __mithic_run: { guest, isUrl, imports } } — OF1/G2 stage 2: the iframe mints
 *     an in-sandbox blob: module for the guest (unless isUrl) and one per dep in `imports`,
 *     builds the frozen `boot.imports` (specifier → blob: URL), `import()`s the guest, and calls
 *     its default export (`mod.default`, or `globalThis.__mithic_default` for an IIFE guest) with
 *     boot. Requires script-src blob: (see the CSP above); the guest URL is revoked after its
 *     import() resolves, dep blob URLs live for the iframe lifetime.
 *  3. Non-init, non-run messages are forwarded to globalThis.__mithic_recv if set.
 *  4. Guest posts messages back via window.parent.postMessage() which the IframeRuntime
 *     listens to via a window.onmessage listener on the host page.
 */
export function buildSrcdoc(csp: string = DEFAULT_GUEST_CSP): string {
  // Defensive fail-loud (G6-CSP-manifest): the csp is interpolated raw into the
  // double-quoted meta `content="..."`. A double-quote (or `<`/`>`) in a malformed
  // compiled CSP could break out of the attribute / tag. manifestCsp never emits
  // these (its directives are single-quoted tokens only), so a value containing one
  // is a bug — throw rather than emit a broken/injectable srcdoc.
  if (/["<>]/.test(csp)) {
    throw new Error('buildSrcdoc: csp must not contain a double-quote, "<" or ">" (meta-attribute breakout)');
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head>
<body>
<script type="module">
// WebRTC egress control (spec §3.4). CSP3 \`webrtc 'block'\` is NOT enforced by any
// shipping browser, and RTCPeerConnection is outside the connect-src fallback chain,
// so it defaults to allowed — a compromised guest could exfiltrate over a data channel.
// The ACTUAL control is deleting the constructors before the guest runs. This runs at
// bootstrap module-eval time, strictly before any __mithic_run guest code arrives async.
// RTCPeerConnection is [Exposed=Window] only, so this is iframe-scoped (the Worker global
// does not expose it — no shim needed there). The list targets the standard, Chromium
// (webkit) and legacy Firefox (moz) constructor names; a future engine that ships a WebRTC
// constructor under a new prefix MUST be added here.
try { delete globalThis.RTCPeerConnection; } catch (_e) { globalThis.RTCPeerConnection = undefined; }
try { delete globalThis.webkitRTCPeerConnection; } catch (_e) { globalThis.webkitRTCPeerConnection = undefined; }
try { delete globalThis.mozRTCPeerConnection; } catch (_e) { globalThis.mozRTCPeerConnection = undefined; }
try { delete globalThis.RTCDataChannel; } catch (_e) { globalThis.RTCDataChannel = undefined; }
try { delete globalThis.mozRTCDataChannel; } catch (_e) { globalThis.mozRTCDataChannel = undefined; }

// Bootstrap protocol: mirrors worker.ts BOOTSTRAP_SOURCE but for an iframe context.
// Communication is via window.parent.postMessage / window.onmessage with port transfer.
let __mithic_boot = null;

// self.__post sends a message up to the kernel host via the parent window.
self.__post = (msg, transfer) => {
  window.parent.postMessage(msg, '*', transfer || []);
};

window.onmessage = (e) => {
  const data = e.data;
  if (data && typeof data === 'object' && '__mithic_init' in data) {
    const ports = Array.isArray(data.ports) ? data.ports : [];
    // K2: data.preopenFds (when present) maps ports[1..] to arbitrary guest fds;
    // otherwise fall back to positional mapping (ports[i] -> fd i-1).
    const preopenFds = Array.isArray(data.preopenFds) ? data.preopenFds : null;
    const preopenPorts = {};
    for (let i = 1; i < ports.length; i++) {
      if (ports[i] == null) continue;
      const fd = preopenFds ? preopenFds[i - 1] : i - 1;
      if (typeof fd === 'number') preopenPorts[fd] = ports[i];
    }
    __mithic_boot = { control: ports[0], init: data.__mithic_init, preopenPorts, imports: {} };
  } else if (data && typeof data === 'object' && '__mithic_run' in data && data.__mithic_run && typeof data.__mithic_run === 'object') {
    // OF1/G2 stage 2 (spec §4.2): mint an in-sandbox blob: module for the guest + each dep
    // (same-origin to THIS opaque iframe), build boot.imports, then import() the guest.
    // The old export-default regex rewrite + (0,eval) path is REMOVED — this is the sole path.
    // Requires script-src blob: (see the CSP above). Dep blob URLs live for the iframe lifetime
    // (reclaimed at teardown); the guest URL is revoked after its import() resolves.
    const run = async () => {
      const spec = data.__mithic_run;
      const deps = (spec.imports && typeof spec.imports === 'object') ? spec.imports : {};
      const importsMap = {};
      for (const name in deps) {
        if (typeof deps[name] !== 'string') continue;
        importsMap[name] = URL.createObjectURL(new Blob([deps[name]], { type: 'text/javascript' }));
      }
      Object.freeze(importsMap);
      __mithic_boot.imports = importsMap;
      let guestUrl = spec.guest;
      const minted = !spec.isUrl;
      if (minted) guestUrl = URL.createObjectURL(new Blob([spec.guest], { type: 'text/javascript' }));
      let mod;
      try {
        mod = await import(guestUrl);
      } finally {
        if (minted) URL.revokeObjectURL(guestUrl);
      }
      const entry = (mod && typeof mod.default === 'function') ? mod.default : globalThis.__mithic_default;
      if (typeof entry === 'function') await Promise.resolve(entry(__mithic_boot));
    };
    run().catch((err) => { window.parent.postMessage({ __mithic_error: String(err) }, '*'); });
  } else {
    const recv = globalThis.__mithic_recv;
    if (typeof recv === 'function') recv(data);
  }
};
</script>
</body>
</html>`;
}

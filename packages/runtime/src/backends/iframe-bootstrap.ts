/**
 * Builds an HTML srcdoc string for use as an iframe's srcdoc attribute.
 *
 * The resulting document:
 *  - Has a locked-down CSP that allows only inline scripts/styles (no external fetches)
 *  - Runs an inline module script that implements the same __mithic_init / __mithic_run
 *    bootstrap protocol as worker.ts BOOTSTRAP_SOURCE, but over window.postMessage
 *    with the opener/parent as the host
 *  - Reconstructs the boot object: { control, init, preopenPorts }
 *  - Calls the guest module's default export with the boot object
 *
 * Protocol (same as WorkerRuntime):
 *  1. Host sends { __mithic_init: ProcessInit, ports: Transferable[] } with a transfer list.
 *     ports[0] = control MessagePort, ports[1..] = stdio MessagePorts.
 *  2. Host sends { __mithic_run: string } containing the guest module source.
 *  3. The iframe rewrites `export default` → `globalThis.__mithic_default =` so the code
 *     can be safely eval'd as a classic script. Falls back to extracting __mithic_default
 *     or __mithic_main from the guest globals. Supports the WorkerRuntime bootstrap protocol
 *     (globalThis.__mithic_default / __mithic_main) as well as the ESM default-export pattern.
 *  4. Non-init, non-run messages are forwarded to globalThis.__mithic_recv if set.
 *  5. Guest posts messages back via window.parent.postMessage() which the IframeRuntime
 *     listens to via a window.onmessage listener on the host page.
 */
export function buildSrcdoc(): string {
  return `<!DOCTYPE html>
<html>
<head>
<!--
  Opaque-origin guest sandbox CSP (see spec §3.3/§5). This is DELIBERATELY permissive
  for code execution ('unsafe-inline' 'unsafe-eval') — isolation here comes from the
  opaque origin + postMessage-only egress, NOT from script-src. Do not "harden" this
  into a general-web XSS policy. Rules:
   - img/media/font-src take blob: AND data: (passive, guest-produced assets, local only —
     NO remote origins: a remote asset GET is an exfil channel connect-src cannot stop, §9 rule 2).
   - connect-src 'none' blocks fetch/XHR/WebSocket/EventSource/sendBeacon/<a ping> — network is
     the net/fetch syscall, not the guest (§3.4).
   - form-action/base-uri 'none' are belt-and-suspenders; navigation/popup/form egress is closed
     PRIMARILY by the sandbox="allow-scripts" attribute (no allow-forms/allow-popups/
     allow-top-navigation). ANY future sandbox-flag addition must re-run the §3.4 threat model.
   - webrtc 'block' is DECLARED but NOT enforced by shipping browsers (CSP3 "Other Directive") —
     the REAL WebRTC control is the RTCPeerConnection/RTCDataChannel shim below (Task A2).
   - worker-src stays ABSENT → falls back to default-src 'none' → blocks nested Worker/SharedWorker.
   - script-src does NOT get data: (ever) and does NOT get blob: yet (Task Group D adds blob: for
     the guest-module import()).
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; img-src blob: data:; media-src blob: data:; font-src blob: data:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'">
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
    __mithic_boot = { control: ports[0], init: data.__mithic_init, preopenPorts };
  } else if (data && typeof data === 'object' && '__mithic_run' in data && typeof data.__mithic_run === 'string') {
    const run = async () => {
      // Rewrite ESM export syntax to globalThis assignments so the code can be
      // eval'd as a classic script. This supports both the ESM default-export
      // pattern (export default ...) and direct globalThis.__mithic_default assignments.
      // We replace ALL occurrences of 'export default' since the guest string may
      // have multiple such patterns (prelude + actual export).
      let src = data.__mithic_run;
      // Replace "export default" at statement position with a globalThis assignment so
      // the code can be eval'd as a classic script.
      //
      // CONSTRAINT: This rewrite is valid only for controlled host-provided guest strings.
      // The regex is anchored to line-start (^ in multiline mode) with optional leading
      // whitespace so it does NOT match "export default" embedded mid-line inside a string
      // literal or comment on the same line as other code.
      // Example safe:     export default function() {}
      // Example NOT hit:  const x = "export default x";  (mid-line, not at line start)
      // If a guest contains "export default" at the start of a line inside a string,
      // that guest code is not supported -- it must use a different string delimiter or
      // set globalThis.__mithic_default directly.
      src = src.replace(/^[ \\t]*export\\s+default\\s+/mg, 'globalThis.__mithic_default = ');
      // Also strip any remaining bare 'export { ... }' or 'export const' etc.
      // that might appear in ESM guest code — not expected in inline guest strings.
      (0, eval)(src);
      const defaultExport = globalThis.__mithic_default;
      const main = globalThis.__mithic_main;
      if (typeof defaultExport === 'function') {
        // Clear so the next __mithic_run doesn't accidentally re-use this value
        globalThis.__mithic_default = undefined;
        await Promise.resolve(defaultExport(__mithic_boot));
      } else if (typeof main === 'function') {
        main();
      }
    };
    run().catch((err) => {
      window.parent.postMessage({ __mithic_error: String(err) }, '*');
    });
  } else {
    const recv = globalThis.__mithic_recv;
    if (typeof recv === 'function') recv(data);
  }
};
</script>
</body>
</html>`;
}

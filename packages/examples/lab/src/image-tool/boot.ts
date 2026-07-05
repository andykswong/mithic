import { createLab } from '../main.ts';
import type { Lab } from '../main.ts';
import { IframeRuntime } from '@mithic/runtime/backends/iframe';
import { portToReadable } from '@mithic/guest-runtime';
import { installResizeConvertWorkflow } from './workflow.ts';
import { installImageToolGuest, IMAGE_TOOL_PATH } from './guest-install.ts';
import { forwardMarkers, consoleSink, beaconSink, type TelemetrySink } from './telemetry.ts';

export interface BootOptions {
  /** Where the visible app-guest iframe mounts. */
  root: HTMLElement;
  /** First-party telemetry endpoint; when omitted, events go to the console sink only (no egress). */
  telemetryEndpoint?: string;
}

export interface ImageToolHandle {
  lab: Lab;
  pid: number;
  dispose(): void;
}

/**
 * Boot the image-tool page: an IframeRuntime-backed lab, the workflow + app guest
 * installed, and the visible app guest spawned with a LIVE stdout pipe the host
 * drains into the telemetry sink. Image bytes never touch the host — the guest owns
 * ingest/preview/download; the host only forwards content-free markers and handles
 * the CTA navigation. No COOP/COEP required (iframe backend, no SharedArrayBuffer).
 */
export async function bootImageTool(options: BootOptions): Promise<ImageToolHandle> {
  const runtime = new IframeRuntime({ container: options.root });
  const lab = await createLab({ persistStorage: null, runtime });
  await installResizeConvertWorkflow(lab.vfs);
  await installImageToolGuest(lab.vfs);

  const sink: TelemetrySink = options.telemetryEndpoint ? beaconSink(options.telemetryEndpoint) : consoleSink;

  const pipe = lab.kernel.ipc.createPipe();
  void forwardMarkers(portToReadable(pipe.readPort), (ev) => {
    sink(ev);
    // CTA navigation is host-side (the sandboxed guest cannot navigate/popup).
    if (ev.name === 'cta_clicked') {
      // A real deployment routes to the "run at scale / self-host" page. Kept as a
      // documented hook here so the demand signal is captured before navigation.
      // window.open('/self-host', '_blank', 'noopener');
    }
  });

  const { pid } = await lab.kernel.spawn(IMAGE_TOOL_PATH, {
    args: ['image-tool'],
    env: { PATH: '/usr/bin:/bin', PWD: '/' },
    cwd: '/',
    capabilities: [
      { type: 'fs', paths: ['/'], operations: ['read', 'write', 'execute'] },
      { type: 'process', maxChildren: 16 },
    ],
    stdout: pipe.writePort,
    display: { mode: 'window', width: 480, height: 720, container: options.root, allowDownloads: true },
  });

  return { lab, pid, dispose: () => lab.dispose() };
}

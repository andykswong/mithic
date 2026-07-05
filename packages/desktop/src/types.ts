import type { Kernel, DisplayOptions } from '@mithic/kernel';
import type { Capability } from '@mithic/protocol';

/** A rectangle in desktop pixels. */
export interface Rect { x: number; y: number; w: number; h: number; }

export type WindowState = 'normal' | 'minimized' | 'maximized';

/** One open window: its chrome DOM, geometry, and lifecycle. */
export interface MithicWindow {
  readonly id: number;
  pid?: number;
  title: string;
  /** The chrome root (titlebar + content), mounted in the desktop surface for life. */
  readonly frame: HTMLElement;
  /** Where host DOM (tier-1) or the guest iframe (tier-2) lives. */
  readonly content: HTMLElement;
  state: WindowState;
  geometry: Rect;
  z: number;
}

/** Handed to a tier-1 app's mount() — the app draws into `content`. */
export interface WindowContext {
  readonly window: MithicWindow;
  readonly content: HTMLElement;
  readonly kernel: Kernel;
  /** Register cleanup to run when the window closes. */
  onClose(cb: () => void | Promise<void>): void;
  /** Set the window title (updates titlebar + taskbar). */
  setTitle(title: string): void;
}

/** A registered app. Exactly one of `mount` (tier-1 host DOM) or `entry` (tier-2 iframe guest). */
export interface AppDescriptor {
  name: string;
  title: string;
  icon?: string;
  defaultSize: [number, number];
  resizable?: boolean;
  singleton?: boolean;
  capabilities?: Capability[];
  /**
   * GUI display mode (from the app's manifest `display.mode`). Threaded into the
   * tier-2 `kernel.spawn` `display.mode` so the guest learns its surface via
   * `guest.display`. `'hidden'` makes the guest see `available:false` (headless).
   * Defaults to `'window'` when unset.
   */
  displayMode?: 'window' | 'fullscreen' | 'hidden';
  /**
   * G6-CSP-manifest (spec §9): the per-guest iframe CSP compiled from the app's
   * manifest `assets` (via `manifestCsp`). Threaded into the tier-2 `kernel.spawn`
   * `csp` so the guest's iframe applies exactly the policy its manifest declares
   * (a manifest with no `assets` yields a CSP with no img/media/font-src — the
   * guest cannot render passive assets unless it opts in). Undefined = the iframe
   * falls back to the runtime's DEFAULT_GUEST_CSP.
   */
  csp?: string;
  /** Tier-1: render host DOM into the window. */
  mount?: (ctx: WindowContext, argv: string[]) => void | Promise<void>;
  /** Tier-2: sandboxed iframe guest entry (inline source string or URL). */
  entry?: string | URL;
}

/** Options for opening a window. */
export interface OpenOptions {
  argv?: string[];
  display?: Partial<DisplayOptions>;
}

/**
 * Shell variable environment (C4).
 *
 * Extracted from {@link Executor} as the object that IS the {@link ShellEnv} the
 * {@link Expander} consumes. It owns the VARIABLE storage — scalar vars, indexed
 * arrays, associative arrays — plus the dynamic identity/state vars (`$RANDOM`
 * generator, `$SHLVL` recompute, `BASH_VERSION` / `BASH_VERSINFO`). The
 * tell-tale SoC smell it removes is the executor's old 17-method `withOverlay`
 * hand-copy: a command-prefix overlay (`FOO=bar cmd`) is now just
 * {@link Environment.child}, a real child env that reads the overlay first and
 * writes through to the parent's scalar store.
 *
 * Cross-cutting `ShellEnv` concerns that depend on executor state — command
 * substitution, glob VFS access, `set -u`/POSIX/`shopt` flags, positional and
 * status specials — are delegated to an injected {@link EnvHost} so the
 * Environment stays a focused variable store and a child env shares the host.
 */
import type { ShellEnv } from './expander.ts';
import type { ShellContext } from './executor.ts';

/**
 * Bash identity version (G7). Matches the reference shell's config:
 * `BASH_VERSION` = `5.3.0(1)-release`; `BASH_VERSINFO` = the 6-element array.
 */
export const BASH_VERSINFO_ELEMENTS = ['5', '3', '0', '1', 'release', 'mithic'] as const;
export const BASH_VERSION_STRING =
  `${BASH_VERSINFO_ELEMENTS[0]}.${BASH_VERSINFO_ELEMENTS[1]}.${BASH_VERSINFO_ELEMENTS[2]}` +
  `(${BASH_VERSINFO_ELEMENTS[3]})-${BASH_VERSINFO_ELEMENTS[4]}`;

/**
 * Compute `$SHLVL` from an inherited value (G7), per bash: <0 / 0 / >=1000 reset
 * to 1; otherwise increment.
 */
export function computeShlvl(inherited: number): number {
  if (!Number.isFinite(inherited) || inherited < 0 || inherited === 0 || inherited >= 1000) return 1;
  return inherited + 1;
}

/**
 * Executor-state surface the {@link Environment} needs to satisfy the full
 * {@link ShellEnv} contract: the status / positional specials, and the
 * cross-cutting command-sub / glob / flag accessors. A child env shares the same
 * host as its parent, so an overlay env transparently re-uses all of it.
 */
export interface EnvHost {
  lastStatus(): number;
  lastBgPid(): number;
  pipeStatus(): number[];
  /** 1-based source line of the statement currently executing, for `$LINENO`. */
  currentLine(): number;
  /** The short-flag letters of currently-enabled options, for `$-`. */
  currentFlags(): string;
  /** The LIVE indexed-array map (read fresh: a subshell may reassign it). */
  arrays(): Map<string, string[]>;
  /** The LIVE associative-array map. */
  assocArrays(): Map<string, Map<string, string>>;
  nounset(): boolean;
  posix(): boolean;
  shopt(name: string): boolean;
  runCommandSub(src: string): Promise<string>;
  listDir(path: string): Promise<string[] | undefined>;
  statPath(path: string): Promise<{ dir: boolean } | undefined>;
  procSub(src: string, dir: 'in' | 'out'): Promise<string>;
  /**
   * Resolve a `declare -n` nameref to its target (single-level), or undefined if
   * `name` is not a nameref. Variable reads dereference through this. Optional.
   */
  resolveNameref?(name: string): string | undefined;
  /**
   * Attribute flags of a variable for `${var@a}` (`r`/`n`/`a`/`A`; scalar → '').
   * Derived from the executor's readonly/nameref/array/assoc state. Optional.
   */
  attrFlags?(name: string): string;
  /** True when `name` is `readonly` (checked on the resolved target). Optional. */
  isReadonly?(name: string): boolean;
  /** Write a non-fatal diagnostic to the current stderr frame. Optional. */
  warn?(msg: string): void;
}

export class Environment implements ShellEnv {
  private context: ShellContext;
  private host: EnvHost;
  /** LCG state for `$RANDOM` (G7); seedable via `RANDOM=n`. Boxed so child envs share it. */
  private randomBox: { state: bigint };
  /**
   * A child-overlay scalar store (a layered proxy). For the ROOT env this is
   * undefined and the live `context.env` is used directly — so a subshell that
   * REASSIGNS `context.env` (save/restore) is honored without a stale reference.
   */
  private overlayVars: Record<string, string> | undefined;

  constructor(
    context: ShellContext,
    host: EnvHost,
    randomBox?: { state: bigint },
    overlayVars?: Record<string, string>,
  ) {
    this.context = context;
    this.host = host;
    this.randomBox = randomBox ?? { state: BigInt(Date.now()) ^ 0x9e3779b97f4a7c15n };
    this.overlayVars = overlayVars;
  }

  /** The live scalar store: a child's layered proxy, else `context.env` (read fresh). */
  private get vars(): Record<string, string> { return this.overlayVars ?? this.context.env; }
  /** Indexed arrays — read fresh from the host so a subshell's array reassignment is seen. */
  private get arrays(): Map<string, string[]> { return this.host.arrays(); }
  private get assocArrays(): Map<string, Map<string, string>> { return this.host.assocArrays(); }

  /**
   * A command-prefix overlay env (`FOO=bar cmd`): reads the overlay scalars
   * first, falling back to the parent; a write lands in BOTH the overlay and the
   * parent's scalar store (bash: `FOO=bar` is visible to the command and, for an
   * exported/assigned name, persists). Arrays/assoc/specials/RANDOM are shared by
   * reference with the parent — only scalar lookups are layered.
   */
  child(overlay: Record<string, string>): Environment {
    const parent = this.vars;
    const layered = new Proxy({ ...parent, ...overlay }, {
      get: (t, p: string) => (t as Record<string, string>)[p],
      set: (t, p: string, v: string) => { (t as Record<string, string>)[p] = v; parent[p] = v; return true; },
      has: (t, p: string) => p in (t as Record<string, string>),
      deleteProperty: (t, p: string) => { delete (t as Record<string, string>)[p]; return true; },
    }) as Record<string, string>;
    return new Environment(this.context, this.host, this.randomBox, layered);
  }

  /** Advance the LCG and return a 0..32767 pseudo-random integer ($RANDOM). */
  private nextRandom(): number {
    this.randomBox.state = (this.randomBox.state * 6364136223846793005n + 1442695040888963407n)
      & 0xffffffffffffffffn;
    return Number((this.randomBox.state >> 33n) % 32768n);
  }

  /** Seed `$RANDOM` (used by `RANDOM=n`). */
  seedRandom(seed: number): void { this.randomBox.state = BigInt(seed >>> 0); }

  // ── ShellEnv: variable storage ─────────────────────────────────────────────

  /** Single-level `declare -n` nameref deref: `ref` → its target (else `name`). */
  private deref(name: string): string {
    return this.host.resolveNameref?.(name) ?? name;
  }

  /**
   * Public nameref resolution for the expander (`${ref@A}` must reconstruct
   * `declare -n ref=target` — the TARGET NAME, not its value). Returns the target
   * name if `name` is a nameref, else `undefined` (distinct from {@link deref},
   * which falls back to `name`). Delegates to the executor's host hook.
   */
  resolveNameref(name: string): string | undefined {
    return this.host.resolveNameref?.(name);
  }

  get(name: string): string | undefined {
    name = this.deref(name);
    // `RANDOM` is dynamic — never let a stored value shadow the generator
    // (assignment seeds it via `set`). `getSpecial` produces the value.
    if (name === 'RANDOM') return undefined;
    return this.vars[name];
  }

  set(name: string, value: string): void {
    // A `declare -n ref=target` write lands on the TARGET — deref first, mirroring
    // get()/has(). This makes `${ref:=x}` default-assign write `target`, not `ref`.
    // It is idempotent for applyAssignment (which pre-derefs before calling set).
    name = this.deref(name);
    // Assigning `RANDOM=n` seeds the generator rather than storing a scalar.
    if (name === 'RANDOM') {
      const seed = parseInt(value, 10);
      if (!Number.isNaN(seed)) this.seedRandom(seed);
      return;
    }
    // `SHLVL` is recomputed from the assigned value (bash); `BASH_VERSION` /
    // `BASH_VERSINFO` are read-only identity vars (G7).
    if (name === 'SHLVL') {
      const n = parseInt(value, 10);
      this.vars.SHLVL = String(computeShlvl(Number.isNaN(n) ? 0 : n));
      return;
    }
    if (name === 'BASH_VERSION' || name === 'BASH_VERSINFO') return;
    this.vars[name] = value;
  }

  has(name: string): boolean {
    name = this.deref(name);
    if (name === 'RANDOM' || name === 'BASH_VERSION' || name === 'BASH_VERSINFO') return true;
    return name in this.vars;
  }

  getArray(name: string): string[] | undefined {
    name = this.deref(name);
    if (name === 'BASH_VERSINFO') return [...BASH_VERSINFO_ELEMENTS];
    return this.arrays.get(name);
  }

  /** Write one indexed-array element (for `a[i]=…` arithmetic lvalues). Creates
   * the array if absent; a negative index counts from the end (clamped at 0). */
  setArrayElement(name: string, index: number, value: string): void {
    name = this.deref(name);
    const arr = this.arrays.get(name) ?? [];
    let i = index < 0 ? arr.length + index : index;
    if (i < 0) i = 0;
    arr[i] = value;
    this.arrays.set(name, arr);
  }

  getAssoc(name: string): Map<string, string> | undefined { return this.assocArrays.get(this.deref(name)); }

  get cwd(): string { return this.context.cwd; }

  getSpecial(name: string): string | undefined {
    switch (name) {
      case '?': return String(this.host.lastStatus());
      case '#': return String((this.context.positional ?? []).length);
      case '$': return String(this.context.pid ?? 0);
      // `$!` is empty (not "0") until a background job has been started.
      case '!': return this.host.lastBgPid() === 0 ? '' : String(this.host.lastBgPid());
      case '-': return this.host.currentFlags();
      case '0': return this.context.name ?? 'sh';
      case '@':
      case '*': return (this.context.positional ?? []).join(' ');
      case 'PIPESTATUS': return this.host.pipeStatus().join(' ');
      // `$LINENO`: the source line of the statement currently executing.
      case 'LINENO': return String(this.host.currentLine());
      // Bash identity/state vars (G7).
      case 'RANDOM': return String(this.nextRandom());
      case 'BASH_VERSION': return BASH_VERSION_STRING;
      case 'BASH_VERSINFO': return BASH_VERSINFO_ELEMENTS[0]; // bare ref → element 0
    }
    if (/^[1-9][0-9]*$/.test(name)) {
      return (this.context.positional ?? [])[parseInt(name, 10) - 1];
    }
    return undefined;
  }

  getPositional(): string[] { return this.context.positional ?? []; }

  /** All set variable names (scalars + arrays), for `${!prefix*}`/`${!prefix@}`. */
  names(): string[] {
    return [...new Set([...Object.keys(this.vars), ...this.arrays.keys()])];
  }

  /** `${var@a}` attribute flags — delegated to the executor host (scalar → ''). */
  attrFlags(name: string): string { return this.host.attrFlags?.(name) ?? ''; }

  /**
   * True when the variable is `readonly`. Derefs first so a nameref pointing at a
   * readonly target is also reported readonly (matching {@link set}'s deref). Used
   * by the expander's `${var:=x}`/`${var=x}` default-assign.
   */
  isReadonly(name: string): boolean { return this.host.isReadonly?.(this.deref(name)) ?? false; }

  /** Emit a non-fatal diagnostic to the executor's current stderr frame. */
  warn(msg: string): void { this.host.warn?.(msg); }

  // ── ShellEnv: cross-cutting (delegated to the executor host) ────────────────

  nounset(): boolean { return this.host.nounset(); }
  posix(): boolean { return this.host.posix(); }
  shopt(name: string): boolean { return this.host.shopt(name); }
  runCommandSub(src: string): Promise<string> { return this.host.runCommandSub(src); }
  listDir(path: string): Promise<string[] | undefined> { return this.host.listDir(path); }
  statPath(path: string): Promise<{ dir: boolean } | undefined> { return this.host.statPath(path); }
  procSub(src: string, dir: 'in' | 'out'): Promise<string> { return this.host.procSub(src, dir); }
}

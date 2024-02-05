import { symAsync, symFn } from './symbol.ts';
import { AsyncValue, Bindings, Env } from './types.ts';

/** Environment that resolves values using object prototype chain. */
export class ProtoChainEnv implements Env {
  protected readonly binds: Bindings;

  public constructor(
    public readonly parent: ProtoChainEnv | null = null,
    constants: Bindings = {},
  ) {
    this.binds = Object.create(parent?.binds ?? null);
    const descriptors: PropertyDescriptorMap = {};
    for (const [key, value] of Object.entries(constants)) {
      descriptors[key] = { value, writable: false };
    }
    Object.defineProperties(this.binds, descriptors);
  }

  public get global(): ProtoChainEnv {
    return this.parent?.global ?? this;
  }

  public get fn(): boolean {
    return !!this.binds[symFn];
  }

  public set fn(isFn: boolean) {
    this.binds[symFn] = isFn;
  }

  public get async(): boolean {
    if (this.global === this) { return true; } // global scope is always async
    return !!this.binds[symAsync];
  }

  public set async(isAsync: boolean) {
    this.binds[symAsync] = isAsync;
  }

  public get(name: string): AsyncValue | undefined {
    return this.binds[name];
  }

  public getOwn(name: string): AsyncValue | undefined {
    return Object.hasOwn(this.binds, name) ? this.binds[name] : void 0;
  }

  public set<V extends AsyncValue>(name: string, value: V): V {
    if (!(name in this.binds)) {
      return (this.binds[name] = value) as V;
    }

    let binds = this.binds;
    while (!Object.hasOwn(binds, name)) { binds = Object.getPrototypeOf(binds); }
    return (binds[name] = value) as V;
  }

  public setOwn<V extends AsyncValue>(name: string, value: V, readOnly = false): V {
    if (readOnly) {
      Object.defineProperty(this.binds, name, { value, writable: false });
      return value;
    }
    return (this.binds[name] = value) as V;
  }

  public push(): ProtoChainEnv {
    return new ProtoChainEnv(this);
  }
}

/** Default environment implementation. */
export const DefaultEnv = ProtoChainEnv;

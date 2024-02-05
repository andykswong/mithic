import { MaybePromise } from '@mithic/commons';
import { symAsync, symEnv, symFn, symFnArgs, symFnBody, symMacro } from './symbol.ts';

/** metael AST evaluator. */
export interface Evaluator {
  /** Compiles given JSON AST into an unscoped function. */
  compile<Args extends unknown[] = AsyncValue[]>(expr: JSONType, args?: string[]): FnValue<Args>;

  /** Evaluates a JSON AST in given environment. Returns Promise for async code. */
  eval(expr: JSONType, env: Env): AsyncValue<Value>;
}

/** metael expression parser. */
export interface Parser {
  /** Parses given expression string into JSON AST. */
  parse(expr: string): JSONType;

  /** Prints given value or AST as string. */
  print(expr: AsyncValue): string;
}

/** Environment that defines variable scope. */
export interface Env {
  /** Returns the parent env scope, or null if the env is the global scope. */
  readonly parent: Env | null;

  /** Returns the global env scope. */
  readonly global: Env;

  /** Indicates if current scope is within a function. */
  fn: boolean;

  /** Indicates if the env is async. */
  async: boolean;

  /** Gets a variable. */
  get(name: string): AsyncValue | undefined;

  /** Gets a variable defined on current scope. */
  getOwn(name: string): AsyncValue | undefined;

  /** Sets a variable. */
  set<V extends AsyncValue>(name: string, value: V): V;

  /** Sets a variable on current scope. */
  setOwn<V extends AsyncValue>(name: string, value: V, readOnly?: boolean): V;

  /** Push a new scope to the stack and returns the new env. */
  push(): Env;
}

/** Variable bindings. */
export interface Bindings {
  [key: string | symbol]: AsyncValue;
}

/** Primitive types. */
export type Primitive = string | number | boolean;

/** Input value type. */
export type JSONType = null | Primitive | JSONType[] | { [key: string]: JSONType };

/** Awaited value type. */
export type Value =
  null | Primitive |
  AsyncValue[] |
  ObjValue |
  FnValue<AsyncValue[]>
  /** | NativeObject */;

/** A {@link Value} that may be wrapped with a Promise. */
export type AsyncValue<V = Value> = MaybePromise<V>;

/** Object value type. */
export type ObjValue = { [key: string]: AsyncValue };

/** Function value type. */
export type FnValue<Args extends unknown[] = AsyncValue[]>
  = ((this: Env, ...args: Args) => AsyncValue) & UserFnDef & AsyncFnDef & MacroFnDef;

/** Async function value type. */
export type AsyncFnValue<Args extends unknown[] = AsyncValue[]> = FnValue<Args> & Required<AsyncFnDef>;

/** Macro function value type. */
export type MacroValue<Args extends unknown[] = AsyncValue[]> = FnValue<Args> & Required<MacroFnDef>;

/** Macro function discriminator. */
export interface MacroFnDef {
  /** Discriminator for macros. */
  [symMacro]?: true;
}

/** Async function discriminator. */
export interface AsyncFnDef {
  /** Discriminator for async function. */
  [symAsync]?: true;
}

/** User function definitions. */
export interface UserFnDef {
  /** Discriminator for user defined functions. */
  [symFn]?: true;

  /** Env scope in which the function is declared in, or null for global scope. */
  [symEnv]?: Env | null;

  /** Argument names for this function. */
  [symFnArgs]?: string[];

  /** Function body. */
  [symFnBody]?: AsyncValue;
}

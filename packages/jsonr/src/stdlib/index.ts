import { Bindings } from '../types.ts';
import * as Ops from './ops.ts';
import * as Predicates from './predicates.ts';
import * as Types from './types.ts';

/** Standard type conversion bindings. */
export const StdType = Object.freeze({ ...Types, ...Predicates }) satisfies Bindings;

/** Standard operation bindings. */
export const StdOp = Object.freeze({
  '+': Ops.plus,
  '-': Ops.minus,
  '*': Ops.times,
  '/': Ops.div,
  '**': Ops.pow,
  '%': Ops.rem,
  '^': Ops.xor,
  '&': Ops.and,
  '|': Ops.or,
  '~': Ops.inv,
  '!': Ops.not,
  '<': Ops.lessThan,
  '>': Ops.greaterThan,
  '<=': Ops.lessEquals,
  '>=': Ops.greaterEquals,
  '===': Ops.equals,
  '!==': Ops.notEquals,
  'delete': Ops.del,
  'in': Ops.contains,
  '.': Ops.get,
  '.=': Ops.set,
  '.()': Ops.call,
  '[]': Types.array,
  '...': Types.concat,
}) satisfies Bindings;

/** Standard library bindings. */
export const Stdlib = Object.freeze({ ...StdType, ...StdOp }) satisfies Bindings;

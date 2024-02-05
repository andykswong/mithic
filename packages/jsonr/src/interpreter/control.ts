import { symCtrl } from '../symbol.ts';
import { AsyncValue } from '../types.ts';

export enum ControlFlag {
  None = 0,
  TailCall = 1 << 0,
  Return = 1 << 1,
  Break = 1 << 2,
  Continue = 1 << 3,
}

export type ControlValue<Flag extends ControlFlag = ControlFlag> = {
  [symCtrl]: Flag;
  value: AsyncValue;
}

export function isControl(expr: AsyncValue): expr is ControlValue {
  return expr !== null && typeof expr === 'object' && symCtrl in expr;
}

export function isLoopControl(expr: AsyncValue): expr is ControlValue<ControlFlag.Break | ControlFlag.Continue> {
  return isControl(expr) && !!(expr[symCtrl] & (ControlFlag.Break | ControlFlag.Continue));
}

export function isReturn(expr: AsyncValue): expr is ControlValue<ControlFlag.Return> {
  return isControl(expr) && !!(expr[symCtrl] & ControlFlag.Return);
}

export function unwrapReturn(value: ControlValue, flags = ControlFlag.None) {
  return (flags && ControlFlag.TailCall) ? value.value : value;
}

/** EntityAttrReducer that returns the first value. */
export function first<V>(
  result: V | undefined, value: V, _attr: string, _tag: string
): V {
  return result !== void 0 ? result : value;
}

/** EntityAttrReducer that returns the last value. */
export function last<V>(
  _result: V | undefined, value: V, _attr: string, _tag: string
): V {
  return value;
}

/** EntityAttrReducer that returns values as key-value entries. */
export function asEntries<V>(
  result: [attr: string, value: V][] | undefined, value: V, _attr: string, tag: string
): [tag: string, value: V][] {
  result = result || [];
  result.push([tag, value]);
  return result;
}

/** EntityAttrReducer that returns values as array. */
export function asArray<V>(
  result: V[] | undefined, value: V, _attr: string, _tag: string
): V[] {
  result = result || [];
  result.push(value);
  return result;
}

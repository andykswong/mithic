/**
 * JSON value helpers shared by the interpreter and builtins: jq's type names,
 * total ordering, deep equality, and a canonical serializer used by `tojson`,
 * `@json`, object-key sorting, and `unique`/`group_by`.
 *
 * jq values are the JSON value set: null, boolean, number, string, array,
 * object. We model them as the corresponding JS values (objects = plain
 * records, arrays = JS arrays). `undefined` is never a jq value.
 */

export type JSONValue = null | boolean | number | string | JSONValue[] | { [k: string]: JSONValue };

/** jq's `type` builtin names, in jq's sort order. */
export type JQType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

export function typeOf(v: unknown): JQType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

const TYPE_RANK: Record<JQType, number> = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };

/** jq truthiness: only `null` and `false` are falsy. */
export function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/** Deep equality over JSON values. */
export function equal(a: unknown, b: unknown): boolean {
  return compare(a, b) === 0;
}

/**
 * jq's total order: null < false < true < numbers < strings < arrays < objects.
 * Arrays compare lexicographically; objects compare by sorted keys then values.
 */
export function compare(a: unknown, b: unknown): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb];
  switch (ta) {
    case 'null': return 0;
    case 'boolean': return (a === b) ? 0 : (a ? 1 : -1);
    case 'number': return (a as number) - (b as number) === 0 ? 0 : ((a as number) < (b as number) ? -1 : 1);
    case 'string': return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case 'array': {
      const aa = a as unknown[];
      const ba = b as unknown[];
      const len = Math.min(aa.length, ba.length);
      for (let i = 0; i < len; i++) {
        const c = compare(aa[i], ba[i]);
        if (c !== 0) return c;
      }
      return aa.length - ba.length;
    }
    case 'object': {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const ak = Object.keys(ao).sort();
      const bk = Object.keys(bo).sort();
      // compare key arrays first
      const kc = compare(ak, bk);
      if (kc !== 0) return kc;
      for (const k of ak) {
        const c = compare(ao[k], bo[k]);
        if (c !== 0) return c;
      }
      return 0;
    }
  }
}

/**
 * Canonical JSON serializer matching jq's output. `indent` of 0 → compact;
 * positive → pretty with that many spaces; a string → that literal indent
 * (used for `--tab`). `sortKeys` orders object keys lexicographically.
 */
export function toJSON(v: unknown, indent: number | string = 0, sortKeys = false): string {
  const pad = typeof indent === 'string' ? indent : ' '.repeat(indent);
  const pretty = pad.length > 0;

  const enc = (val: unknown, depth: number): string => {
    const t = typeOf(val);
    switch (t) {
      case 'null': return 'null';
      case 'boolean': return val ? 'true' : 'false';
      case 'number': return formatNumber(val as number);
      case 'string': return JSON.stringify(val);
      case 'array': {
        const arr = val as unknown[];
        if (arr.length === 0) return '[]';
        if (!pretty) return '[' + arr.map((e) => enc(e, depth + 1)).join(',') + ']';
        const inner = pad.repeat(depth + 1);
        return '[\n' + arr.map((e) => inner + enc(e, depth + 1)).join(',\n') + '\n' + pad.repeat(depth) + ']';
      }
      case 'object': {
        const obj = val as Record<string, unknown>;
        let keys = Object.keys(obj);
        if (sortKeys) keys = keys.sort();
        if (keys.length === 0) return '{}';
        if (!pretty) return '{' + keys.map((k) => JSON.stringify(k) + ':' + enc(obj[k], depth + 1)).join(',') + '}';
        const inner = pad.repeat(depth + 1);
        return '{\n' + keys.map((k) => inner + JSON.stringify(k) + ': ' + enc(obj[k], depth + 1)).join(',\n') + '\n' + pad.repeat(depth) + '}';
      }
    }
  };
  return enc(v, 0);
}

/**
 * Format a number the way jq 1.7 does. jq renders doubles with a David-Gay
 * `g_fmt`-style formatter over the shortest round-tripping digit string:
 * integers print without a decimal point, while sufficiently large/small
 * magnitudes switch to exponential notation (`1e+20`, `1.5e-10`). NaN/Inf → null.
 *
 * We derive the shortest significant digits and decimal-point position from JS's
 * own shortest representation (`Number.prototype.toString`, which is shortest
 * round-trip), then apply jq's g_fmt decision: exponential when
 * `decpt <= -4 || decpt > ndigits + 15`.
 */
export function formatNumber(n: number): string {
  if (!isFinite(n)) return 'null';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';

  const sign = n < 0 ? '-' : '';
  const str = Math.abs(n).toString();

  // Extract shortest significant digits `s` and `decpt` = number of digits to
  // the left of the decimal point (value = 0.s × 10^decpt).
  let s: string;
  let decpt: number;
  const e = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(str);
  if (e) {
    const intp = e[1];
    const frac = e[2] ?? '';
    const exp = parseInt(e[3], 10);
    s = (intp + frac).replace(/0+$/, '') || '0';
    decpt = exp + intp.length;
  } else {
    const d = /^(\d+)(?:\.(\d+))?$/.exec(str)!;
    const intp = d[1];
    const frac = d[2] ?? '';
    if (intp === '0') {
      let lead = 0;
      while (lead < frac.length && frac[lead] === '0') lead++;
      s = frac.slice(lead).replace(/0+$/, '') || '0';
      decpt = -lead;
    } else {
      s = (intp + frac).replace(/0+$/, '') || '0';
      decpt = intp.length;
    }
  }

  const ndig = s.length;
  // jq g_fmt: use exponential when the point is far left or far right.
  if (decpt <= -4 || decpt > ndig + 15) {
    const mant = s.length > 1 ? s[0] + '.' + s.slice(1) : s;
    const exp = decpt - 1;
    const es = (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
    return sign + mant + 'e' + es;
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + s;
  if (decpt >= ndig) return sign + s + '0'.repeat(decpt - ndig);
  return sign + s.slice(0, decpt) + '.' + s.slice(decpt);
}

/** Render a value as a jq "string" — strings pass through, others are tojson. */
export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  return toJSON(v, 0);
}

/** Deep clone a JSON value (for safe in-place path updates). */
export function clone<T>(v: T): T {
  return structuredClone(v);
}

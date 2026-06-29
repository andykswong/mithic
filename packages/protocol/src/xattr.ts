import type { Capability } from './process.ts';

export const SECURITY_CAPABILITY_XATTR = 'security.capability';

export function encodeCapabilities(caps: Capability[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(caps));
}

/**
 * Default-deny: undefined, unparseable, or any malformed/unrecognized element
 * → no capabilities. A forged xattr must never yield a partially-trusted grant,
 * so a single bad element rejects the whole array (strict whole-array reject).
 */
export function decodeCapabilities(bytes: Uint8Array | undefined): Capability[] {
  if (!bytes || bytes.byteLength === 0) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || !parsed.every(isCapability)) return [];
    return parsed as Capability[];
  } catch {
    return [];
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(e => typeof e === 'string');

function isCapability(value: unknown): value is Capability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const cap = value as Record<string, unknown>;
  switch (cap.type) {
    case 'fs':
      return isStringArray(cap.paths)
        && Array.isArray(cap.operations)
        && cap.operations.every(op => op === 'read' || op === 'write' || op === 'execute');
    case 'net':
      return isStringArray(cap.origins);
    case 'ipc':
      return isStringArray(cap.channels);
    case 'process':
      return cap.maxChildren === undefined || typeof cap.maxChildren === 'number';
    case 'env':
      return true;
    default:
      return false;
  }
}

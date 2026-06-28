import type { Capability } from './process.ts';

export const SECURITY_CAPABILITY_XATTR = 'security.capability';

export function encodeCapabilities(caps: Capability[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(caps));
}

/** Default-deny: undefined or unparseable → no capabilities. */
export function decodeCapabilities(bytes: Uint8Array | undefined): Capability[] {
  if (!bytes || bytes.byteLength === 0) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) ? (parsed as Capability[]) : [];
  } catch {
    return [];
  }
}

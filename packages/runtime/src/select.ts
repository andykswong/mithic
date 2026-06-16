import {
  WORKER_CAPABILITIES,
  IFRAME_CAPABILITIES,
  QUICKJS_CAPABILITIES,
  IVM_CAPABILITIES,
  type RuntimeCapabilities,
} from './runtime.ts';

export type BackendName = 'worker' | 'iframe' | 'quickjs' | 'ivm';

const BACKEND_CAPABILITIES: Record<BackendName, RuntimeCapabilities> = {
  worker: WORKER_CAPABILITIES,
  iframe: IFRAME_CAPABILITIES,
  quickjs: QUICKJS_CAPABILITIES,
  ivm: IVM_CAPABILITIES,
};

export interface SelectPolicy {
  preferred?: BackendName;
  fallbackOrder?: BackendName[];
  requirements?: Partial<RuntimeCapabilities>;
}

export interface SelectContext {
  available: BackendName[];
}

function meetsRequirements(caps: RuntimeCapabilities, requirements: Partial<RuntimeCapabilities>): boolean {
  for (const [key, value] of Object.entries(requirements) as [keyof RuntimeCapabilities, boolean][]) {
    if (caps[key] !== value) return false;
  }
  return true;
}

export function selectBackend(policy: SelectPolicy, context: SelectContext): BackendName {
  const { preferred, fallbackOrder = ['worker', 'iframe', 'quickjs', 'ivm'], requirements } = policy;
  const { available } = context;

  const candidates: BackendName[] = preferred != null
    ? [preferred, ...fallbackOrder.filter((b) => b !== preferred)]
    : fallbackOrder;

  for (const candidate of candidates) {
    if (!available.includes(candidate)) continue;
    const caps = BACKEND_CAPABILITIES[candidate];
    if (requirements == null || meetsRequirements(caps, requirements)) {
      return candidate;
    }
  }

  throw new Error(
    `No available backend satisfies requirements: ${JSON.stringify(requirements)}. Available: ${available.join(', ')}`
  );
}

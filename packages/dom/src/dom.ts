import type { RootProvider } from './service.ts';
import * as root from './root.ts';
import { HtmlStringRootProvider } from './impl/index.ts';
import { ListenerFQN, type DomGuest } from './types.ts';

let provider: RootProvider;

/** DOM module. */
export const Dom = {
  /** The underlying DOM root provider. */
  get provider(): RootProvider {
    if (!provider) {
      provider = new HtmlStringRootProvider();
    }
    return provider;
  },
  set provider(value: RootProvider) {
    provider = value;
  },

  /** DOM module imports. */
  imports: {
    'mithic:dom/root': root,
  },

  /** Adds guest component as event listener. */
  addEventListener(guest: DomGuest): void {
    const listener = guest[ListenerFQN];
    if (listener) {
      this.provider.addEventListener?.(listener);
    }
  },
};

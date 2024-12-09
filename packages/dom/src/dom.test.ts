import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { Dom } from './dom.ts';
import type { RootProvider } from './service.ts';
import { ListenerFQN, type DomEventListener, type DomGuest } from './types.ts';

describe('Dom', () => {
  let provider: ReturnType<typeof createMockRootProvider>;

  beforeEach(() => {
    Dom.provider = provider = createMockRootProvider();
  });

  describe('addEventListener', () => {
    it('should register guest module as event listener', () => {
      const guest = {
        [ListenerFQN]: {
          onDomEvent: mock.fn(),
        }
      } satisfies DomGuest;

      Dom.addEventListener(guest);
      assert.strictEqual(provider.addEventListener.mock.callCount(), 1);
      assert.deepStrictEqual(provider.addEventListener.mock.calls[0].arguments, [guest[ListenerFQN]]);
    });
  });
});

function createMockRootProvider() {
  return {
    create: mock.fn(),
    addEventListener: mock.fn<(listener: DomEventListener, onEachFrame?: boolean) => void>(),
  } satisfies RootProvider;
}

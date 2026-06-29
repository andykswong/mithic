import { expect, describe, it, beforeEach } from 'vitest';
import { MetadataStore, type MetadataBacking } from './metadata-store.ts';

/** In-memory backing that records every flush so tests can assert persistence. */
class RecordingBacking implements MetadataBacking {
  json: string | undefined;
  flushes = 0;

  constructor(initial?: string) {
    this.json = initial;
  }

  load(): string | undefined {
    return this.json;
  }

  flush(json: string): void {
    this.json = json;
    this.flushes++;
  }
}

describe('MetadataStore', () => {
  let backing: RecordingBacking;
  let store: MetadataStore;

  beforeEach(async () => {
    backing = new RecordingBacking();
    store = new MetadataStore(backing);
    await store.load();
  });

  describe('rename (prefix-aware)', () => {
    it('migrates a descendant xattr to the new path and removes the old', async () => {
      await store.setxattr('/dir', 'security.capability', new Uint8Array([1]));
      await store.setxattr('/dir/child', 'security.capability', new Uint8Array([2]));
      await store.setxattr('/dir/sub/deep', 'user.k', new Uint8Array([3]));

      await store.rename('/dir', '/moved');

      expect(Array.from((await store.getxattr('/moved', 'security.capability'))!)).toEqual([1]);
      expect(Array.from((await store.getxattr('/moved/child', 'security.capability'))!)).toEqual([2]);
      expect(Array.from((await store.getxattr('/moved/sub/deep', 'user.k'))!)).toEqual([3]);

      expect(await store.getxattr('/dir', 'security.capability')).toBeUndefined();
      expect(await store.getxattr('/dir/child', 'security.capability')).toBeUndefined();
      expect(await store.getxattr('/dir/sub/deep', 'user.k')).toBeUndefined();
    });

    it('does not migrate sibling paths that merely share a name prefix', async () => {
      await store.setxattr('/dir', 'user.k', new Uint8Array([1]));
      await store.setxattr('/dir-sibling', 'user.k', new Uint8Array([9]));

      await store.rename('/dir', '/moved');

      expect(Array.from((await store.getxattr('/dir-sibling', 'user.k'))!)).toEqual([9]);
      expect(await store.getxattr('/moved', 'user.k')).toBeDefined();
    });

    it('clears any pre-existing dest exact entry and subtree before migrating', async () => {
      await store.setxattr('/src', 'user.k', new Uint8Array([1]));
      await store.setxattr('/dst', 'security.capability', new Uint8Array([66]));
      await store.setxattr('/dst/stale', 'security.capability', new Uint8Array([67]));

      await store.rename('/src', '/dst');

      expect(Array.from((await store.getxattr('/dst', 'user.k'))!)).toEqual([1]);
      expect(await store.getxattr('/dst', 'security.capability')).toBeUndefined();
      expect(await store.getxattr('/dst/stale', 'security.capability')).toBeUndefined();
    });

    it('flushes and persists when src has no meta but dest does (no resurrection on reload)', async () => {
      await store.setxattr('/dst', 'security.capability', new Uint8Array([66]));
      await store.setxattr('/dst/stale', 'security.capability', new Uint8Array([67]));
      const before = backing.flushes;

      await store.rename('/src', '/dst');

      expect(backing.flushes).toBeGreaterThan(before);

      const reloaded = new MetadataStore(backing);
      await reloaded.load();
      expect(await reloaded.getxattr('/dst', 'security.capability')).toBeUndefined();
      expect(await reloaded.getxattr('/dst/stale', 'security.capability')).toBeUndefined();
    });

    it('does not flush when neither src nor dest has any metadata', async () => {
      const before = backing.flushes;
      await store.rename('/nope', '/also-nope');
      expect(backing.flushes).toBe(before);
    });
  });

  describe('dropSubtree', () => {
    it('removes the exact key and all descendants', async () => {
      await store.setxattr('/d', 'user.k', new Uint8Array([1]));
      await store.setxattr('/d/a', 'user.k', new Uint8Array([2]));
      await store.setxattr('/d/a/b', 'user.k', new Uint8Array([3]));
      await store.setxattr('/d-sibling', 'user.k', new Uint8Array([9]));

      await store.dropSubtree('/d');

      expect(await store.getxattr('/d', 'user.k')).toBeUndefined();
      expect(await store.getxattr('/d/a', 'user.k')).toBeUndefined();
      expect(await store.getxattr('/d/a/b', 'user.k')).toBeUndefined();
      expect(Array.from((await store.getxattr('/d-sibling', 'user.k'))!)).toEqual([9]);
    });

    it('persists the drop so a reload does not resurrect descendants', async () => {
      await store.setxattr('/d', 'user.k', new Uint8Array([1]));
      await store.setxattr('/d/a', 'user.k', new Uint8Array([2]));

      await store.dropSubtree('/d');

      const reloaded = new MetadataStore(backing);
      await reloaded.load();
      expect(await reloaded.getxattr('/d', 'user.k')).toBeUndefined();
      expect(await reloaded.getxattr('/d/a', 'user.k')).toBeUndefined();
    });

    it('does not flush when nothing matches', async () => {
      await store.setxattr('/other', 'user.k', new Uint8Array([1]));
      const before = backing.flushes;
      await store.dropSubtree('/missing');
      expect(backing.flushes).toBe(before);
    });
  });
});

/**
 * Group M — guest-side remote DOM serializer tests (node).
 *
 * Verifies that mutations to the virtual DOM produce the expected serialized
 * DomMutation record shapes WITHOUT any real DOM or syscall infrastructure.
 * MutationSerializer.drain() captures pending records synchronously.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MutationSerializer } from './remote-dom.ts';
import { openRoot } from './fs-access.ts';
import type { Guest } from './guest.ts';

// ---------------------------------------------------------------------------
// Minimal stub guest — syscall never actually called in these unit tests
// (drain() is used instead of flush())
// ---------------------------------------------------------------------------
function makeStubGuest(): Guest {
  return {
    pid: 1,
    args: [],
    env: {},
    cwd: '/',
    stdin: new ReadableStream(),
    stdout: new WritableStream(),
    stderr: new WritableStream(),
    syscall: async () => undefined,
    syscallPorts: async () => ({ result: undefined, ports: [] }),
    pipe: async () => ({ readfd: 0, writefd: 0 }),
    connect: async () => ({ connfd: 0 }),
    fetch: (async () => { throw new Error('fetch not used in this stub'); }) as typeof fetch,
    fs: openRoot(async () => undefined),
    onSignal: () => undefined,
    signal: new AbortController().signal,
    isatty: () => false,
    exit: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MutationSerializer — createElement', () => {
  it('emits a createElement record with normalized lower-case tag', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('DIV');
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'createElement', id: el.id, tag: 'div' });
  });

  it('assigns a unique id to each created node', () => {
    const s = new MutationSerializer(makeStubGuest());
    const a = s.createElement('span');
    const b = s.createElement('p');
    expect(a.id).not.toBe(b.id);
  });
});

describe('MutationSerializer — createTextNode', () => {
  it('emits a createText record with the given text', () => {
    const s = new MutationSerializer(makeStubGuest());
    const t = s.createTextNode('hello world');
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'createText', id: t.id, text: 'hello world' });
  });

  it('text node has nodeType === "text" and no tagName', () => {
    const s = new MutationSerializer(makeStubGuest());
    const t = s.createTextNode('x');
    expect(t.nodeType).toBe('text');
    expect(t.tagName).toBeUndefined();
  });
});

describe('MutationSerializer — setAttribute', () => {
  it('emits a setAttribute record', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('input');
    s.drain(); // clear createElement record
    el.setAttribute('type', 'text');
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'setAttribute', id: el.id, name: 'type', value: 'text' });
  });

  it('getAttribute returns the set value', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('div');
    el.setAttribute('class', 'foo');
    expect(el.getAttribute('class')).toBe('foo');
  });

  it('emits a removeAttribute record', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('div');
    el.setAttribute('hidden', '');
    s.drain();
    el.removeAttribute('hidden');
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'removeAttribute', id: el.id, name: 'hidden' });
  });

  it('removeAttribute on non-existent attribute emits nothing', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('div');
    s.drain();
    el.removeAttribute('nonexistent');
    expect(s.drain()).toHaveLength(0);
  });
});

describe('MutationSerializer — appendChild', () => {
  it('emits an appendChild record', () => {
    const s = new MutationSerializer(makeStubGuest());
    const parent = s.createElement('ul');
    const child = s.createElement('li');
    s.drain(); // clear creates
    parent.appendChild(child);
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'appendChild', parentId: parent.id, childId: child.id });
  });

  it('tracks parent/children references', () => {
    const s = new MutationSerializer(makeStubGuest());
    const parent = s.createElement('ul');
    const child = s.createElement('li');
    parent.appendChild(child);
    expect(child.parent).toBe(parent);
    expect(parent.children).toContain(child);
  });

  it('re-parenting a child emits removeChild then appendChild', () => {
    const s = new MutationSerializer(makeStubGuest());
    const p1 = s.createElement('div');
    const p2 = s.createElement('div');
    const child = s.createElement('span');
    p1.appendChild(child);
    s.drain(); // clear previous mutations
    p2.appendChild(child);
    const records = s.drain();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: 'removeChild', parentId: p1.id, childId: child.id });
    expect(records[1]).toMatchObject({ type: 'appendChild', parentId: p2.id, childId: child.id });
  });
});

describe('MutationSerializer — removeChild', () => {
  it('emits a removeChild record', () => {
    const s = new MutationSerializer(makeStubGuest());
    const parent = s.createElement('div');
    const child = s.createElement('span');
    parent.appendChild(child);
    s.drain();
    parent.removeChild(child);
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'removeChild', parentId: parent.id, childId: child.id });
  });

  it('throws when child is not in parent', () => {
    const s = new MutationSerializer(makeStubGuest());
    const parent = s.createElement('div');
    const orphan = s.createElement('span');
    expect(() => parent.removeChild(orphan)).toThrow();
  });

  it('clears parent reference after remove', () => {
    const s = new MutationSerializer(makeStubGuest());
    const parent = s.createElement('div');
    const child = s.createElement('span');
    parent.appendChild(child);
    parent.removeChild(child);
    expect(child.parent).toBeNull();
    expect(parent.children).not.toContain(child);
  });
});

describe('MutationSerializer — textContent', () => {
  it('setTextContent on a text node emits setTextContent record', () => {
    const s = new MutationSerializer(makeStubGuest());
    const t = s.createTextNode('initial');
    s.drain();
    t.textContent = 'updated';
    const records = s.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ type: 'setTextContent', id: t.id, text: 'updated' });
  });

  it('setTextContent on element removes children and emits setTextContent', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('p');
    const child = s.createElement('span');
    el.appendChild(child);
    s.drain();
    el.textContent = 'plain text';
    const records = s.drain();
    // removeChild for child + setTextContent for el
    const removeRec = records.find(r => r.type === 'removeChild');
    const setRec = records.find(r => r.type === 'setTextContent');
    expect(removeRec).toBeDefined();
    expect(setRec).toEqual({ type: 'setTextContent', id: el.id, text: 'plain text' });
  });

  it('textContent getter on element concatenates descendant text', () => {
    const s = new MutationSerializer(makeStubGuest());
    const el = s.createElement('div');
    const t1 = s.createTextNode('foo');
    const t2 = s.createTextNode('bar');
    el.appendChild(t1);
    el.appendChild(t2);
    expect(el.textContent).toBe('foobar');
  });
});

describe('MutationSerializer — flush (syscall integration)', () => {
  it('flush sends mutations via syscall("dom/mutate", { mutations }) and clears pending', async () => {
    let lastCall: { call: string; args: Record<string, unknown> } | undefined;
    const guest = makeStubGuest();
    guest.syscall = async (call, args) => { lastCall = { call, args }; return undefined; };

    const s = new MutationSerializer(guest);
    s.createElement('div');
    const count = await s.flush();

    expect(count).toBe(1);
    expect(lastCall?.call).toBe('dom/mutate');
    expect(Array.isArray((lastCall?.args as { mutations: unknown }).mutations)).toBe(true);
    expect(((lastCall?.args as { mutations: unknown[] }).mutations)).toHaveLength(1);
    // After flush the pending list is empty
    expect(s.drain()).toHaveLength(0);
  });

  it('flush with no pending mutations is a no-op (returns 0)', async () => {
    let callCount = 0;
    const guest = makeStubGuest();
    guest.syscall = async () => { callCount++; return undefined; };
    const s = new MutationSerializer(guest);
    const count = await s.flush();
    expect(count).toBe(0);
    expect(callCount).toBe(0);
  });
});

describe('MutationSerializer — sequential mutation record shapes', () => {
  let s: MutationSerializer;
  beforeEach(() => { s = new MutationSerializer(makeStubGuest()); });

  it('createElement/appendChild/setAttribute produce expected record sequence', () => {
    const root = s.createElement('section');
    const h1 = s.createElement('h1');
    h1.setAttribute('class', 'title');
    const text = s.createTextNode('Hello');
    h1.appendChild(text);
    root.appendChild(h1);

    const records = s.drain();
    expect(records).toEqual([
      { type: 'createElement', id: root.id, tag: 'section' },
      { type: 'createElement', id: h1.id, tag: 'h1' },
      { type: 'setAttribute', id: h1.id, name: 'class', value: 'title' },
      { type: 'createText', id: text.id, text: 'Hello' },
      { type: 'appendChild', parentId: h1.id, childId: text.id },
      { type: 'appendChild', parentId: root.id, childId: h1.id },
    ]);
  });
});

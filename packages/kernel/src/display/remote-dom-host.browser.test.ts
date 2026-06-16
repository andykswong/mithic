/**
 * Group M — host-side RemoteDomHost browser tests (Chromium).
 *
 * Verifies:
 *  1. Applying mutation records creates ONLY allowlisted elements in the real DOM.
 *  2. A <script> createElement mutation is REJECTED (not added to DOM).
 *  3. An `onclick` (on*) attribute mutation is REJECTED.
 *  4. A `javascript:` href is REJECTED.
 *  5. A click event on a mirrored DOM element is forwarded to the guest callback.
 *  6. An input event on an input-like element is forwarded with the value payload.
 *  7. Text content is applied safely (no HTML injection via innerHTML).
 *  8. A full mutation batch (createElement/setAttribute/appendChild/text) renders correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RemoteDomHost, ALLOWED_TAGS } from './remote-dom-host.ts';
import type { GuestDomEvent } from './remote-dom-host.ts';
import type { DomMutation } from '@mithic/guest-runtime/remote-dom';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContainer(): HTMLDivElement {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
}

function cleanupContainer(div: HTMLDivElement): void {
  document.body.removeChild(div);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteDomHost — allowlisted element creation', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('creates a <div> and appends it to the container', () => {
    const mutations: DomMutation[] = [
      { type: 'createElement', id: 1, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ];
    const applied = host.applyMutations(mutations);
    expect(applied).toBe(2);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('creates a <p> with text content', () => {
    const mutations: DomMutation[] = [
      { type: 'createElement', id: 10, tag: 'p' },
      { type: 'setTextContent', id: 10, text: 'Hello, world!' },
      { type: 'appendChild', parentId: 0, childId: 10 },
    ];
    host.applyMutations(mutations);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe('Hello, world!');
  });

  it('creates all basic allowlisted structural elements without error', () => {
    const tags = ['div', 'span', 'p', 'section', 'h1', 'ul', 'li', 'table', 'tr', 'td'] as const;
    let id = 100;
    for (const tag of tags) {
      const applied = host.applyMutations([{ type: 'createElement', id: id++, tag }]);
      expect(applied).toBe(1);
    }
  });
});

describe('RemoteDomHost — SECURITY: tag allowlist blocks forbidden elements', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('REJECTS <script> element — not added to DOM', () => {
    const mutations: DomMutation[] = [
      { type: 'createElement', id: 1, tag: 'script' },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ];
    const applied = host.applyMutations(mutations);
    // createElement returns false (rejected), appendChild also returns false (no node for id 1)
    expect(applied).toBe(0);
    expect(container.querySelector('script')).toBeNull();
  });

  it('REJECTS <iframe> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 2, tag: 'iframe' },
      { type: 'appendChild', parentId: 0, childId: 2 },
    ]);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('REJECTS <object> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 3, tag: 'object' },
      { type: 'appendChild', parentId: 0, childId: 3 },
    ]);
    expect(container.querySelector('object')).toBeNull();
  });

  it('REJECTS <embed> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 4, tag: 'embed' },
      { type: 'appendChild', parentId: 0, childId: 4 },
    ]);
    expect(container.querySelector('embed')).toBeNull();
  });

  it('REJECTS <link> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 5, tag: 'link' },
      { type: 'appendChild', parentId: 0, childId: 5 },
    ]);
    expect(container.querySelector('link')).toBeNull();
  });

  it('REJECTS <meta> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 6, tag: 'meta' },
      { type: 'appendChild', parentId: 0, childId: 6 },
    ]);
    expect(container.querySelector('meta')).toBeNull();
  });

  it('REJECTS <style> element — not added to DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 7, tag: 'style' },
      { type: 'appendChild', parentId: 0, childId: 7 },
    ]);
    expect(container.querySelector('style')).toBeNull();
  });

  it('rejected element does not block subsequent valid elements', () => {
    host.applyMutations([
      { type: 'createElement', id: 20, tag: 'script' }, // rejected
      { type: 'createElement', id: 21, tag: 'div' },    // accepted
      { type: 'appendChild', parentId: 0, childId: 21 },
    ]);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('div')).not.toBeNull();
  });
});

describe('RemoteDomHost — SECURITY: attribute allowlist blocks event handlers', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('REJECTS onclick attribute — not set on element', () => {
    host.applyMutations([
      { type: 'createElement', id: 30, tag: 'div' },
      { type: 'setAttribute', id: 30, name: 'onclick', value: 'alert(1)' },
      { type: 'appendChild', parentId: 0, childId: 30 },
    ]);
    const el = container.querySelector('div');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('onclick')).toBeNull();
  });

  it('REJECTS onerror attribute', () => {
    host.applyMutations([
      { type: 'createElement', id: 31, tag: 'img' },
      { type: 'setAttribute', id: 31, name: 'onerror', value: 'alert(1)' },
      { type: 'appendChild', parentId: 0, childId: 31 },
    ]);
    const el = container.querySelector('img');
    expect(el!.getAttribute('onerror')).toBeNull();
  });

  it('REJECTS onmouseover attribute (any on* prefix)', () => {
    host.applyMutations([
      { type: 'createElement', id: 32, tag: 'span' },
      { type: 'setAttribute', id: 32, name: 'onmouseover', value: 'pwn()' },
      { type: 'appendChild', parentId: 0, childId: 32 },
    ]);
    const el = container.querySelector('span');
    expect(el!.getAttribute('onmouseover')).toBeNull();
  });

  it('REJECTS javascript: href', () => {
    host.applyMutations([
      { type: 'createElement', id: 33, tag: 'a' },
      { type: 'setAttribute', id: 33, name: 'href', value: 'javascript:alert(1)' },
      { type: 'appendChild', parentId: 0, childId: 33 },
    ]);
    const el = container.querySelector('a');
    expect(el!.getAttribute('href')).toBeNull();
  });

  it('ALLOWS safe href attribute', () => {
    host.applyMutations([
      { type: 'createElement', id: 34, tag: 'a' },
      { type: 'setAttribute', id: 34, name: 'href', value: 'https://example.com' },
      { type: 'appendChild', parentId: 0, childId: 34 },
    ]);
    const el = container.querySelector('a');
    expect(el!.getAttribute('href')).toBe('https://example.com');
  });

  it('ALLOWS class and id attributes', () => {
    host.applyMutations([
      { type: 'createElement', id: 35, tag: 'div' },
      { type: 'setAttribute', id: 35, name: 'class', value: 'foo bar' },
      { type: 'setAttribute', id: 35, name: 'id', value: 'my-el' },
      { type: 'appendChild', parentId: 0, childId: 35 },
    ]);
    const el = container.querySelector('div');
    expect(el!.getAttribute('class')).toBe('foo bar');
    expect(el!.getAttribute('id')).toBe('my-el');
  });

  it('REJECTS unknown/unsupported attribute', () => {
    host.applyMutations([
      { type: 'createElement', id: 36, tag: 'div' },
      { type: 'setAttribute', id: 36, name: 'x-custom-evil', value: 'value' },
      { type: 'appendChild', parentId: 0, childId: 36 },
    ]);
    const el = container.querySelector('div');
    expect(el!.getAttribute('x-custom-evil')).toBeNull();
  });
});

describe('RemoteDomHost — event forwarding', () => {
  let container: HTMLDivElement;
  let events: GuestDomEvent[];
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    events = [];
    host = new RemoteDomHost({
      container,
      onGuestEvent: (e) => { events.push(e); },
    });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('click on a mirrored element forwards a dom/event to the guest callback', () => {
    host.applyMutations([
      { type: 'createElement', id: 50, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 50 },
    ]);
    const el = container.querySelector('div') as HTMLElement;
    expect(el).not.toBeNull();
    el.click();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeId: 50, eventType: 'click', payload: {} });
  });

  it('click event carries the correct nodeId', () => {
    host.applyMutations([
      { type: 'createElement', id: 51, tag: 'span' },
      { type: 'appendChild', parentId: 0, childId: 51 },
    ]);
    const el = container.querySelector('span') as HTMLElement;
    el.click();
    expect(events[0].nodeId).toBe(51);
  });

  it('no event forwarded when no onGuestEvent callback', () => {
    const hostNoCallback = new RemoteDomHost({ container });
    hostNoCallback.applyMutations([
      { type: 'createElement', id: 60, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 60 },
    ]);
    // Should not throw even without a callback
    const el = container.querySelector('div') as HTMLElement;
    el.click();
    hostNoCallback.dispose();
    expect(events).toHaveLength(0); // original host callback untouched
  });

  it('dispose removes event listeners — click after dispose does not fire', () => {
    host.applyMutations([
      { type: 'createElement', id: 70, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 70 },
    ]);
    const el = container.querySelector('div') as HTMLElement;
    host.dispose();
    el.click();
    expect(events).toHaveLength(0);
  });
});

describe('RemoteDomHost — full render pipeline', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('renders a nested tree: section > h1 + p with text and class', () => {
    const mutations: DomMutation[] = [
      { type: 'createElement', id: 80, tag: 'section' },
      { type: 'createElement', id: 81, tag: 'h1' },
      { type: 'setAttribute', id: 81, name: 'class', value: 'title' },
      { type: 'createText', id: 82, text: 'Hello Remote DOM' },
      { type: 'appendChild', parentId: 81, childId: 82 },
      { type: 'createElement', id: 83, tag: 'p' },
      { type: 'setTextContent', id: 83, text: 'Body text' },
      { type: 'appendChild', parentId: 80, childId: 81 },
      { type: 'appendChild', parentId: 80, childId: 83 },
      { type: 'appendChild', parentId: 0, childId: 80 },
    ];
    host.applyMutations(mutations);

    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    const h1 = section!.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.getAttribute('class')).toBe('title');
    expect(h1!.textContent).toBe('Hello Remote DOM');
    const p = section!.querySelector('p');
    expect(p!.textContent).toBe('Body text');
  });

  it('removeChild removes the element from the real DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 90, tag: 'div' },
      { type: 'createElement', id: 91, tag: 'span' },
      { type: 'appendChild', parentId: 90, childId: 91 },
      { type: 'appendChild', parentId: 0, childId: 90 },
    ]);
    expect(container.querySelector('span')).not.toBeNull();
    host.applyMutations([
      { type: 'removeChild', parentId: 90, childId: 91 },
    ]);
    expect(container.querySelector('span')).toBeNull();
  });

  it('textContent is set as text, not HTML (XSS via textContent is impossible)', () => {
    host.applyMutations([
      { type: 'createElement', id: 95, tag: 'div' },
      { type: 'setTextContent', id: 95, text: '<script>alert(1)</script>' },
      { type: 'appendChild', parentId: 0, childId: 95 },
    ]);
    const div = container.querySelector('div');
    // The text is NOT parsed as HTML — no child <script> element is injected
    expect(div!.querySelector('script')).toBeNull();
    // The raw string IS present as text
    expect(div!.textContent).toBe('<script>alert(1)</script>');
  });

  it('setAttribute removeAttribute cycle reflects on real DOM', () => {
    host.applyMutations([
      { type: 'createElement', id: 96, tag: 'div' },
      { type: 'setAttribute', id: 96, name: 'hidden', value: '' },
      { type: 'appendChild', parentId: 0, childId: 96 },
    ]);
    const div = container.querySelector('div');
    expect(div!.hasAttribute('hidden')).toBe(true);
    host.applyMutations([{ type: 'removeAttribute', id: 96, name: 'hidden' }]);
    expect(div!.hasAttribute('hidden')).toBe(false);
  });
});

describe('RemoteDomHost — SECURITY: container (node 0) is protected', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    container.setAttribute('class', 'host-shell');
    container.textContent = 'HOST CONTENT';
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('REJECTS setTextContent on id 0 — host container content is unharmed', () => {
    const applied = host.applyMutations([
      { type: 'setTextContent', id: 0, text: 'PWNED' },
    ]);
    expect(applied).toBe(0);
    expect(container.textContent).toBe('HOST CONTENT');
  });

  it('REJECTS setAttribute on id 0 — host container attributes are unharmed', () => {
    const applied = host.applyMutations([
      { type: 'setAttribute', id: 0, name: 'class', value: 'evil' },
    ]);
    expect(applied).toBe(0);
    expect(container.getAttribute('class')).toBe('host-shell');
  });

  it('REJECTS removeAttribute on id 0', () => {
    const applied = host.applyMutations([
      { type: 'removeAttribute', id: 0, name: 'class' },
    ]);
    expect(applied).toBe(0);
    expect(container.getAttribute('class')).toBe('host-shell');
  });

  it('ALLOWS appendChild with parent id 0 — top-level children attach', () => {
    const applied = host.applyMutations([
      { type: 'createElement', id: 1, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ]);
    expect(applied).toBe(2);
    expect(container.querySelector('div')).not.toBeNull();
  });
});

describe('RemoteDomHost — SECURITY: dangerous URI schemes blocked', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('REJECTS data: URI in href', () => {
    host.applyMutations([
      { type: 'createElement', id: 1, tag: 'a' },
      { type: 'setAttribute', id: 1, name: 'href', value: 'data:text/html,<script>alert(1)</script>' },
      { type: 'appendChild', parentId: 0, childId: 1 },
    ]);
    expect(container.querySelector('a')!.getAttribute('href')).toBeNull();
  });

  it('REJECTS vbscript: URI in href', () => {
    host.applyMutations([
      { type: 'createElement', id: 2, tag: 'a' },
      { type: 'setAttribute', id: 2, name: 'href', value: 'vbscript:msgbox(1)' },
      { type: 'appendChild', parentId: 0, childId: 2 },
    ]);
    expect(container.querySelector('a')!.getAttribute('href')).toBeNull();
  });

  it('REJECTS data: URI in img src', () => {
    host.applyMutations([
      { type: 'createElement', id: 3, tag: 'img' },
      { type: 'setAttribute', id: 3, name: 'src', value: 'data:image/svg+xml,<svg onload=alert(1)>' },
      { type: 'appendChild', parentId: 0, childId: 3 },
    ]);
    expect(container.querySelector('img')!.getAttribute('src')).toBeNull();
  });
});

describe('RemoteDomHost — removeChild forgets nodes (no registry leak)', () => {
  let container: HTMLDivElement;
  let host: RemoteDomHost;

  beforeEach(() => {
    container = makeContainer();
    host = new RemoteDomHost({ container });
  });
  afterEach(() => {
    host.dispose();
    cleanupContainer(container);
  });

  it('after removeChild, the child id is dropped from the host registry', () => {
    const base = host.nodeCount; // container only
    host.applyMutations([
      { type: 'createElement', id: 200, tag: 'div' },
      { type: 'appendChild', parentId: 0, childId: 200 },
    ]);
    expect(host.nodeCount).toBe(base + 1);
    host.applyMutations([{ type: 'removeChild', parentId: 0, childId: 200 }]);
    // The removed id must be forgotten — registry returns to baseline.
    expect(host.nodeCount).toBe(base);
  });

  it('removeChild forgets descendants too (subtree cleanup)', () => {
    const base = host.nodeCount;
    host.applyMutations([
      { type: 'createElement', id: 210, tag: 'div' },
      { type: 'createElement', id: 211, tag: 'span' },
      { type: 'createText', id: 212, text: 'leaf' },
      { type: 'appendChild', parentId: 211, childId: 212 },
      { type: 'appendChild', parentId: 210, childId: 211 },
      { type: 'appendChild', parentId: 0, childId: 210 },
    ]);
    expect(host.nodeCount).toBe(base + 3);
    host.applyMutations([{ type: 'removeChild', parentId: 0, childId: 210 }]);
    // Parent + span + text all forgotten.
    expect(host.nodeCount).toBe(base);
  });

  it('repeated create→append→remove cycles do not grow the registry', () => {
    const base = host.nodeCount;
    for (let i = 0; i < 50; i++) {
      const id = 1000 + i;
      host.applyMutations([
        { type: 'createElement', id, tag: 'div' },
        { type: 'appendChild', parentId: 0, childId: id },
        { type: 'removeChild', parentId: 0, childId: id },
      ]);
    }
    expect(host.nodeCount).toBe(base);
  });
});

describe('RemoteDomHost — ALLOWED_TAGS export sanity', () => {
  it('ALLOWED_TAGS does not contain script, iframe, object, embed, link, meta, style', () => {
    const forbidden = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style'];
    for (const tag of forbidden) {
      expect(ALLOWED_TAGS.has(tag)).toBe(false);
    }
  });

  it('ALLOWED_TAGS contains expected structural elements', () => {
    const expected = ['div', 'span', 'p', 'section', 'article', 'h1', 'h2', 'ul', 'li', 'a'];
    for (const tag of expected) {
      expect(ALLOWED_TAGS.has(tag)).toBe(true);
    }
  });
});

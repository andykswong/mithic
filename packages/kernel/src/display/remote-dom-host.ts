/**
 * Remote DOM Host — applies guest DOM mutation records to a real DOM container.
 *
 * Security model — allowlist enforcement:
 *   - ALLOWED_TAGS: a fixed set of safe HTML elements. Any element not in this list
 *     is REJECTED and the mutation is silently dropped. `script`, `iframe`, `object`,
 *     `embed`, `link`, `meta`, `style`, `form`, `input`, `button`, `select`,
 *     `textarea`, and HTML event handler attributes are denied.
 *   - ALLOWED_ATTRIBUTES: a per-tag (plus global) set of safe attribute names.
 *     Attribute names that start with "on" (event handlers as strings), "data-"
 *     prefixed names that carry executable content, `href`/`src` with `javascript:`
 *     scheme, and non-listed names are all blocked.
 *   - Text content is always safe — it is set as a text node or via textContent
 *     (never innerHTML), so it cannot inject markup.
 *
 * Event forwarding:
 *   User events (click, input) on mirrored real DOM elements are forwarded back to
 *   the guest via a registered callback `onGuestEvent`. The kernel can wire this to
 *   a kernel event delivered to the guest process (e.g. via a `dom/event` kernel
 *   event). Each forwarded event carries the target element's node id (the virtual
 *   DOM id), the event type, and a payload (e.g. { value } for input events).
 */

import type { DomMutation } from '@mithic/guest-runtime/remote-dom';

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * Safe structural/content HTML tags. Interactive tags that can submit forms or
 * execute scripts are excluded. The host owns what can be rendered.
 */
export const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'section', 'article', 'aside', 'header', 'footer',
  'main', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn',
  'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'strong', 'sub', 'sup',
  'time', 'u', 'var', 'wbr',
  'blockquote', 'pre', 'hr',
  'figure', 'figcaption',
  'details', 'summary',
  'img',
  'audio', 'video', 'track', 'source',
  'canvas',
  'progress', 'meter',
  'label', 'output', 'fieldset', 'legend',
]);

/**
 * Global attributes allowed on all elements.
 * Excludes all `on*` handlers, `style` (could be used for expression injection
 * in older browsers), and `is` (custom elements bypass tag checks).
 */
export const ALLOWED_GLOBAL_ATTRIBUTES = new Set([
  'id', 'class', 'lang', 'dir', 'title', 'tabindex', 'hidden', 'accesskey',
  'contenteditable', 'draggable', 'spellcheck', 'translate',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
  'aria-expanded', 'aria-checked', 'aria-disabled', 'aria-selected',
  'aria-controls', 'aria-live', 'aria-atomic', 'aria-relevant',
  'aria-owns', 'aria-flowto', 'aria-haspopup', 'aria-level',
  'aria-multiline', 'aria-multiselectable', 'aria-orientation',
  'aria-pressed', 'aria-readonly', 'aria-required', 'aria-sort',
  'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
  'role',
  'slot', 'part',
  'data-id', 'data-value', 'data-label', 'data-index', 'data-key', 'data-type',
]);

/** Per-tag extra allowed attributes (extends global list). */
const ALLOWED_PER_TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'target', 'rel', 'download']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes']),
  audio: new Set(['src', 'controls', 'autoplay', 'loop', 'muted', 'preload']),
  video: new Set(['src', 'controls', 'autoplay', 'loop', 'muted', 'preload', 'poster', 'width', 'height']),
  track: new Set(['src', 'kind', 'label', 'srclang', 'default']),
  source: new Set(['src', 'srcset', 'type', 'media', 'sizes']),
  canvas: new Set(['width', 'height']),
  progress: new Set(['value', 'max']),
  meter: new Set(['value', 'min', 'max', 'low', 'high', 'optimum']),
  time: new Set(['datetime']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  td: new Set(['colspan', 'rowspan', 'headers', 'scope']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  details: new Set(['open']),
  label: new Set(['for']),
  output: new Set(['for', 'form', 'name']),
  fieldset: new Set(['disabled', 'form', 'name']),
};

// ---------------------------------------------------------------------------
// Forwarded guest event shape
// ---------------------------------------------------------------------------

export interface GuestDomEvent {
  /** Virtual DOM node id of the target element. */
  nodeId: number;
  /** Event type (e.g. "click", "input"). */
  eventType: string;
  /** Event-specific payload. For "input" events: { value: string }. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RemoteDomHost
// ---------------------------------------------------------------------------

/**
 * Callback invoked when a user event on a mirrored DOM element should be
 * forwarded back to the guest. The kernel wires this to a `dom/event` kernel
 * event delivered to the appropriate guest process.
 */
export type GuestEventCallback = (event: GuestDomEvent) => void;

export interface RemoteDomHostOptions {
  /** The real DOM element that acts as the root container. */
  container: Element;
  /** Called when a forwarded user event needs to reach the guest. */
  onGuestEvent?: GuestEventCallback;
}

/**
 * Applies serialized DOM mutation records from a guest to a real DOM container,
 * enforcing an allowlist of tags and attributes for security.
 *
 * Security guarantee: a guest CANNOT inject `<script>`, `<iframe>`, event
 * handlers, or arbitrary HTML into the host page — only elements/attributes on
 * the allowlist reach the real DOM.
 */
export class RemoteDomHost {
  #container: Element;
  #onGuestEvent: GuestEventCallback | undefined;
  /** Virtual node id → real DOM node. */
  #nodes = new Map<number, Node>();
  /** Real DOM node → virtual node id (for event forwarding). */
  #nodeIds = new WeakMap<Node, number>();
  /** Cleanup callbacks for forwarded event listeners (nodeId → [type, handler][]). */
  #listeners = new Map<number, Array<[string, EventListener]>>();

  constructor(options: RemoteDomHostOptions) {
    this.#container = options.container;
    this.#onGuestEvent = options.onGuestEvent;
    // Register the container itself as node 0 (the implicit root parent).
    this.#nodes.set(0, this.#container);
    this.#nodeIds.set(this.#container, 0);
  }

  /**
   * Apply a batch of mutation records. Records that fail allowlist checks are
   * silently dropped (logged via console.warn in debug builds). Returns the
   * number of mutations actually applied.
   */
  applyMutations(mutations: DomMutation[]): number {
    let applied = 0;
    for (const m of mutations) {
      if (this.#apply(m)) applied++;
    }
    return applied;
  }

  /** Tear down: remove all forwarded event listeners and clear node map. */
  dispose(): void {
    for (const [id, handlers] of this.#listeners) {
      const node = this.#nodes.get(id);
      if (node instanceof EventTarget) {
        for (const [type, handler] of handlers) {
          node.removeEventListener(type, handler);
        }
      }
    }
    this.#listeners.clear();
    this.#nodes.clear();
    this.#nodes.set(0, this.#container);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #apply(m: DomMutation): boolean {
    switch (m.type) {
      case 'createElement':
        return this.#createElement(m.id, m.tag);
      case 'createText':
        return this.#createText(m.id, m.text);
      case 'appendChild':
        return this.#appendChild(m.parentId, m.childId);
      case 'removeChild':
        return this.#removeChild(m.parentId, m.childId);
      case 'setAttribute':
        return this.#setAttribute(m.id, m.name, m.value);
      case 'removeAttribute':
        return this.#removeAttribute(m.id, m.name);
      case 'setTextContent':
        return this.#setTextContent(m.id, m.text);
      default:
        return false;
    }
  }

  #createElement(id: number, tag: string): boolean {
    const normalTag = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(normalTag)) {
      // Reject — tag not on allowlist (e.g. script, iframe, object)
      return false;
    }
    const el = document.createElement(normalTag);
    this.#nodes.set(id, el);
    this.#nodeIds.set(el, id);
    // Wire event forwarding on interactive elements.
    this.#wireEvents(id, el, normalTag);
    return true;
  }

  #createText(id: number, text: string): boolean {
    const node = document.createTextNode(text);
    this.#nodes.set(id, node);
    return true;
  }

  #appendChild(parentId: number, childId: number): boolean {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (!parent || !child) return false;
    parent.appendChild(child);
    return true;
  }

  #removeChild(parentId: number, childId: number): boolean {
    const parent = this.#nodes.get(parentId);
    const child = this.#nodes.get(childId);
    if (!parent || !child) return false;
    try {
      parent.removeChild(child);
    } catch {
      return false;
    }
    return true;
  }

  #setAttribute(id: number, name: string, value: string): boolean {
    const node = this.#nodes.get(id);
    if (!(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    if (!this.#isAttributeAllowed(tag, name, value)) return false;
    node.setAttribute(name, value);
    return true;
  }

  #removeAttribute(id: number, name: string): boolean {
    const node = this.#nodes.get(id);
    if (!(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    if (!this.#isAttributeAllowed(tag, name, '')) return false;
    node.removeAttribute(name);
    return true;
  }

  #setTextContent(id: number, text: string): boolean {
    const node = this.#nodes.get(id);
    if (!node) return false;
    node.textContent = text;
    return true;
  }

  /**
   * Attribute allowlist check.
   * Blocks:
   *   1. Any attribute starting with "on" (event handler as string).
   *   2. `href`/`src`/`action`/`formaction` with a `javascript:` scheme.
   *   3. Any attribute not in the global or per-tag allowlist.
   */
  #isAttributeAllowed(tag: string, name: string, value: string): boolean {
    const lname = name.toLowerCase();
    // Block all on* event handlers (e.g. onclick, onmouseover, onerror)
    if (lname.startsWith('on')) return false;
    // Block javascript: URIs in URL attributes
    if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(lname)) {
      if (/^\s*javascript\s*:/i.test(value)) return false;
    }
    if (ALLOWED_GLOBAL_ATTRIBUTES.has(lname)) return true;
    const perTag = ALLOWED_PER_TAG_ATTRIBUTES[tag];
    if (perTag?.has(lname)) return true;
    return false;
  }

  /**
   * Wire click/input event forwarding for elements where user interaction is
   * meaningful. Only adds listeners for interactive elements to minimise cost.
   */
  #wireEvents(id: number, el: HTMLElement, tag: string): void {
    if (!this.#onGuestEvent) return;
    const handlers: Array<[string, EventListener]> = [];

    const clickable = true; // all elements can be clicked
    if (clickable) {
      const handler: EventListener = (e) => {
        // Only forward if this element is the target (not a bubble from a child
        // that has its own id — the child's listener handles that case).
        if (e.target !== el) return;
        this.#onGuestEvent?.({ nodeId: id, eventType: 'click', payload: {} });
      };
      el.addEventListener('click', handler);
      handlers.push(['click', handler]);
    }

    const isInputLike = ['input', 'textarea', 'select'].includes(tag);
    if (isInputLike) {
      const handler: EventListener = (e) => {
        const target = e.target as HTMLInputElement | null;
        if (!target || target !== el) return;
        this.#onGuestEvent?.({
          nodeId: id,
          eventType: 'input',
          payload: { value: target.value ?? '' },
        });
      };
      el.addEventListener('input', handler);
      handlers.push(['input', handler]);
    }

    if (handlers.length > 0) {
      this.#listeners.set(id, handlers);
    }
  }
}

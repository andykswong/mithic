/**
 * Remote DOM — guest-side virtual DOM serializer.
 *
 * Implementation strategy: minimal faithful implementation (NOT @remote-dom/polyfill).
 * The @remote-dom/polyfill package is heavy and designed for a different architecture.
 * This is a purpose-built, lightweight virtual DOM that produces serializable mutation
 * records matching the host's RemoteDomHost expectation.
 *
 * The guest renders into a lightweight virtual tree. A MutationSerializer watches for
 * changes (via an explicit commit model — no MutationObserver needed in a headless env)
 * and emits batched DomMutation records that the host applies to a real DOM container.
 *
 * Guest → Host communication: `mithic.syscall('dom/mutate', { mutations })`.
 * Host → Guest event forwarding: kernel events with `event: 'dom/event'`.
 */

import type { Guest, GuestDomEventPayload } from './guest.ts';

// ---------------------------------------------------------------------------
// Mutation record types
// ---------------------------------------------------------------------------

export type DomMutation =
  | CreateElementMutation
  | CreateTextMutation
  | AppendChildMutation
  | RemoveChildMutation
  | SetAttributeMutation
  | RemoveAttributeMutation
  | SetTextContentMutation;

export interface CreateElementMutation {
  type: 'createElement';
  id: number;
  tag: string;
}

export interface CreateTextMutation {
  type: 'createText';
  id: number;
  text: string;
}

export interface AppendChildMutation {
  type: 'appendChild';
  parentId: number;
  childId: number;
}

export interface RemoveChildMutation {
  type: 'removeChild';
  parentId: number;
  childId: number;
}

export interface SetAttributeMutation {
  type: 'setAttribute';
  id: number;
  name: string;
  value: string;
}

export interface RemoveAttributeMutation {
  type: 'removeAttribute';
  id: number;
  name: string;
}

export interface SetTextContentMutation {
  type: 'setTextContent';
  id: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Virtual DOM node
// ---------------------------------------------------------------------------

let nextNodeId = 1;

/** A guest-side DOM event listener (mirrors the DOM `EventListener` shape). */
export type VNodeEventListener = (event: GuestDomEventPayload) => void;

/**
 * B4: a guest-side virtual DOM node that IS a real {@link EventTarget}. The
 * earlier hand-rolled `addEventListener`/`removeEventListener`/`dispatchEvent`
 * listener-set is gone — those come straight from `EventTarget`, so guest code
 * uses the standard `element.addEventListener('click', cb, { signal })` surface
 * (including `AbortSignal`-scoped removal). A host-forwarded `dom/event` is
 * dispatched as a standard `CustomEvent(eventType, { detail: payload })`; the
 * MutationSerializer routes it by node id (internal). `#dispatchForwarded`
 * carries the full {@link GuestDomEventPayload} on the event's `detail` so a
 * listener can read `event.detail.payload`.
 */
export class VNode extends EventTarget {
  readonly id: number;
  readonly nodeType: 'element' | 'text';
  readonly tagName: string | undefined;
  #text: string;
  #attributes: Map<string, string>;
  #children: VNode[];
  #parent: VNode | null;
  #serializer: MutationSerializer | null;
  /** Whether this node has registered with the serializer's event-routing map. */
  #tracked = false;

  constructor(
    nodeType: 'element' | 'text',
    tagOrText: string,
    serializer: MutationSerializer | null,
  ) {
    super();
    this.id = nextNodeId++;
    this.nodeType = nodeType;
    this.#serializer = serializer;
    this.#text = '';
    this.#attributes = new Map();
    this.#children = [];
    this.#parent = null;

    if (nodeType === 'element') {
      this.tagName = tagOrText.toLowerCase();
      serializer?.record({ type: 'createElement', id: this.id, tag: this.tagName });
    } else {
      this.tagName = undefined;
      this.#text = tagOrText;
      serializer?.record({ type: 'createText', id: this.id, text: this.#text });
    }
  }

  get children(): readonly VNode[] { return this.#children; }
  get parent(): VNode | null { return this.#parent; }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
    this.#serializer?.record({ type: 'setAttribute', id: this.id, name, value });
  }

  removeAttribute(name: string): void {
    if (!this.#attributes.has(name)) return;
    this.#attributes.delete(name);
    this.#serializer?.record({ type: 'removeAttribute', id: this.id, name });
  }

  getAttribute(name: string): string | null {
    return this.#attributes.has(name) ? (this.#attributes.get(name) ?? null) : null;
  }

  get textContent(): string {
    if (this.nodeType === 'text') return this.#text;
    // For elements, concatenate all descendant text nodes (like the real DOM).
    let result = '';
    for (const child of this.#children) {
      result += child.textContent;
    }
    return result;
  }

  set textContent(value: string) {
    if (this.nodeType === 'text') {
      this.#text = value;
      this.#serializer?.record({ type: 'setTextContent', id: this.id, text: value });
    } else {
      // Remove all children, then set text via a mutation record.
      for (const child of [...this.#children]) {
        this.removeChild(child);
      }
      this.#serializer?.record({ type: 'setTextContent', id: this.id, text: value });
    }
  }

  appendChild(child: VNode): VNode {
    if (child.#parent) {
      child.#parent.removeChild(child);
    }
    child.#parent = this;
    this.#children.push(child);
    this.#serializer?.record({ type: 'appendChild', parentId: this.id, childId: child.id });
    return child;
  }

  removeChild(child: VNode): VNode {
    const idx = this.#children.indexOf(child);
    if (idx === -1) throw new Error('VNode is not a child of this node');
    this.#children.splice(idx, 1);
    child.#parent = null;
    this.#serializer?.record({ type: 'removeChild', parentId: this.id, childId: child.id });
    return child;
  }

  /**
   * Standard {@link EventTarget.addEventListener}. The host's RemoteDomHost
   * forwards user interactions on the mirrored real DOM element via a
   * `dom/event` kernel event; the MutationSerializer demultiplexes by node id
   * and calls {@link dispatchForwarded}, which dispatches a real `CustomEvent`
   * to listeners registered here. Overridden only to register this node with the
   * serializer's routing map on first listener (the dispatch itself is the real
   * EventTarget's). `options`/`AbortSignal`-scoped removal work unchanged.
   */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
    if (!this.#tracked) {
      this.#tracked = true;
      this.#serializer?.trackEventNode(this.id, this);
    }
  }

  /**
   * Internal: dispatch a host-forwarded event as a standard `CustomEvent`. The
   * event-specific payload (e.g. `{ value }` for an input event) rides on
   * `detail`, matching the ergonomic DOM convention; `event.target` is this
   * node. Called by the MutationSerializer's node-id router.
   */
  dispatchForwarded(forwarded: GuestDomEventPayload): void {
    this.dispatchEvent(new CustomEvent(forwarded.eventType, { detail: forwarded.payload ?? {} }));
  }
}

// ---------------------------------------------------------------------------
// Mutation serializer
// ---------------------------------------------------------------------------

/**
 * Collects DomMutation records and flushes them to the kernel via `dom/mutate`.
 *
 * Usage:
 *   const serializer = new MutationSerializer(guest);
 *   const root = serializer.createElement('div');
 *   root.setAttribute('id', 'app');
 *   const text = serializer.createTextNode('Hello');
 *   root.appendChild(text);
 *   await serializer.flush();   // sends all pending mutations to the host
 */
export class MutationSerializer {
  #guest: Guest;
  #pending: DomMutation[] = [];
  /** node id → VNode for nodes that registered host-event listeners. */
  #eventNodes = new Map<number, VNode>();
  #subscribed = false;

  constructor(guest: Guest) {
    this.#guest = guest;
  }

  /** Internal: called by VNode constructors/mutators to record a mutation. */
  record(mutation: DomMutation): void {
    this.#pending.push(mutation);
  }

  /**
   * Internal: register a VNode so forwarded `dom/event` records can be routed to
   * its listeners. Lazily subscribes to the guest's `dom/event` stream on first
   * use so a serializer with no event listeners never installs a control listener.
   */
  trackEventNode(id: number, node: VNode): void {
    this.#eventNodes.set(id, node);
    if (!this.#subscribed && this.#guest.onDomEvent) {
      this.#subscribed = true;
      this.#guest.onDomEvent((event) => this.#dispatch(event));
    }
  }

  /** Route a host-forwarded event to the matching node's listeners. */
  #dispatch(event: GuestDomEventPayload): void {
    this.#eventNodes.get(event.nodeId)?.dispatchForwarded(event);
  }

  createElement(tag: string): VNode {
    return new VNode('element', tag, this);
  }

  createTextNode(text: string): VNode {
    return new VNode('text', text, this);
  }

  /**
   * Flush all pending mutations to the host kernel via `dom/mutate`.
   * Returns the number of mutations sent. No-op if nothing pending.
   */
  async flush(): Promise<number> {
    if (this.#pending.length === 0) return 0;
    const mutations = this.#pending.splice(0);
    await this.#guest.syscall('dom/mutate', { mutations });
    return mutations.length;
  }

  /** Drain pending mutations without sending (for testing). */
  drain(): DomMutation[] {
    return this.#pending.splice(0);
  }
}

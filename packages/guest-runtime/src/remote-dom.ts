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
 * Guest → Host communication: `isola.syscall('dom/mutate', { mutations })`.
 * Host → Guest event forwarding: kernel events with `event: 'dom/event'`.
 */

import type { Guest, GuestDomEventPayload } from './isola.ts';

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

export class VNode {
  readonly id: number;
  readonly nodeType: 'element' | 'text';
  readonly tagName: string | undefined;
  #text: string;
  #attributes: Map<string, string>;
  #children: VNode[];
  #parent: VNode | null;
  #serializer: MutationSerializer | null;
  /** eventType → listeners registered for host-forwarded `dom/event`. */
  #listeners: Map<string, Set<VNodeEventListener>> | undefined;

  constructor(
    nodeType: 'element' | 'text',
    tagOrText: string,
    serializer: MutationSerializer | null,
  ) {
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
   * Register a listener for a host-forwarded DOM event (e.g. "click", "input").
   * The host's RemoteDomHost forwards user interactions on the mirrored real DOM
   * element via a `dom/event` kernel event; the MutationSerializer demultiplexes
   * by node id and invokes the listeners registered here.
   */
  addEventListener(type: string, listener: VNodeEventListener): void {
    if (!this.#listeners) this.#listeners = new Map();
    let set = this.#listeners.get(type);
    if (!set) { set = new Set(); this.#listeners.set(type, set); }
    set.add(listener);
    this.#serializer?.trackEventNode(this.id, this);
  }

  removeEventListener(type: string, listener: VNodeEventListener): void {
    this.#listeners?.get(type)?.delete(listener);
  }

  /** Internal: dispatch a forwarded host event to this node's listeners. */
  dispatchEvent(event: GuestDomEventPayload): void {
    const set = this.#listeners?.get(event.eventType);
    if (!set) return;
    for (const listener of set) listener(event);
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
    this.#eventNodes.get(event.nodeId)?.dispatchEvent(event);
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

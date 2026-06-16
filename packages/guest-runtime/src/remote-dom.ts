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

import type { Guest } from './isola.ts';

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

export class VNode {
  readonly id: number;
  readonly nodeType: 'element' | 'text';
  readonly tagName: string | undefined;
  #text: string;
  #attributes: Map<string, string>;
  #children: VNode[];
  #parent: VNode | null;
  #serializer: MutationSerializer | null;

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

  constructor(guest: Guest) {
    this.#guest = guest;
  }

  /** Internal: called by VNode constructors/mutators to record a mutation. */
  record(mutation: DomMutation): void {
    this.#pending.push(mutation);
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

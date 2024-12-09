import type { Element, ElementId, Root, RootProvider } from '@mithic/dom';
import { createElement } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { ElementRenderer, type ElementRenderState } from './component.ts';
import { replaceRenderState } from './patch.ts';
import { elementEntry, filterObject } from './utils.ts';

/** React DOM {@link RootProvider}. */
export class ReactDomRootProvider implements RootProvider {
  private readonly getRoot: (id: string) => HTMLElement | undefined;

  public constructor({
    getRoot = (id) => document.getElementById(id) ?? undefined,
  }: ReactDomRootProviderOptions = {}) {
    this.getRoot = getRoot;
  }

  public create(identifier: string): Root | undefined {
    const root = this.getRoot(identifier);
    if (root) {
      return new ReactDomRoot(root);
    }
  }
}

export interface ReactDomRootProviderOptions {
  /** Returns root by given ID. */
  getRoot?: (id: string) => HTMLElement | undefined;
}

export class ReactDomRoot implements Root, Disposable {
  private readonly root: ReactRoot;
  private state?: ElementRenderState;
  private tree?: Map<ElementId, Element>;
  private rootId: ElementId = 0n;

  public constructor(root: HTMLElement) {
    this.root = createRoot(root);
  }

  public [Symbol.dispose](): void {
    this.root.unmount();
  }

  public render(elements: Element[], root: ElementId): void {
    this.tree = new Map(elements.map(elementEntry));
    this.rootId = root;
    this._render();
  }

  public update(patches: Element[]): void {
    if (!this.tree) { return; }

    // TODO: patch state directly so that the original tree does not need to be kept
    for (const patch of patches) {
      const element = this.tree.get(patch.id);
      if (element) {
        Object.assign(element, filterObject(patch));
      } else {
        this.tree.set(patch.id, patch);
      }
    }

    this._render();

    if (this.state) { // cleanup unused Elements
      const touched = new Set<ElementId>();
      visit(this.state, touched);
      for (const id of this.tree.keys()) {
        if (!touched.has(id)) {
          this.tree.delete(id);
        }
      }
    }
  }

  private _render() {
    if (!this.tree) { return; }
    this.state = replaceRenderState(this.state, this.tree, this.rootId);
    if (this.state) {
      this.root.render(createElement(ElementRenderer, { root: this.state }));
    } else {
      this.tree = undefined;
      this.root.render(null);
    }
  }
}

function visit(state: ElementRenderState, visited: Set<ElementId>) {
  visited.add(state.id);
  if (state.children) {
    for (const child of state.children) {
      if (typeof child !== 'string') {
        visit(child, visited);
      }
    }
  }
}

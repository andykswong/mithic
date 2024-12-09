import { dispose } from '@mithic/commons';
import { Dom } from './dom.ts';
import { type Root as IRoot } from './service.ts';
import { type DomEvent, type Element, type ElementId } from './types.ts';

/** Creates a virtual DOM root. */
export function create(id: string): Root | undefined {
  const root = Dom.provider.create(id);
  return root ? new Root(root) : root;
}

/** Virtual DOM root. */
export class Root implements Disposable {
  private readonly root: IRoot;

  public constructor(root: IRoot) {
    this.root = root;
  }

  public [Symbol.dispose](): void {
    dispose(this.root);
  }

  /**
   * Render a virtual DOM element tree given by list of elements and the root element ID.
   * Defaults to use the first element as root if not specified.
   */
  public render(elements: Element[], root?: ElementId): void {
    if (elements.length) {
      this.root.render(elements, root ?? elements[0].id);
    }
  }

  /**
   * Update and re-render the DOM with given patches to elements.
   * Has no effect if root has never been rendered before.
   */
  public update(patches: Element[]): void {
    if (patches.length) {
      this.root.update(patches);
    }
  }

  /** Read and pop all events in queue. */
  public readEvents(): DomEvent[] {
    const events = this.root.readEvents?.() ?? [];
    return events;
  }
}

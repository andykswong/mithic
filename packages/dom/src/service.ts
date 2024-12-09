import { type DomEvent, type DomEventListener, type Element, type ElementId } from './types.ts';

/** Virtual DOM Root provider. */
export interface RootProvider extends Partial<EventSource> {
  /** Creates a virtual DOM root. */
  create(identifier: string): Root | undefined;
}

/** Virtual DOM event source. */
export interface EventSource {
  /** Adds event listener. */
  addEventListener(listener: DomEventListener): void;
}

/** Virtual DOM root. */
export interface Root extends Partial<Disposable>, Partial<EventRoot> {
  /** Render a virtual DOM element tree given by list of elements and the root element ID. */
  render(elements: Element[], root: ElementId): void;

  /** Update and re-render the DOM with given patches to elements. Has no effect if root has never been rendered before. */
  update(patches: Element[]): void;
}

/** Virtual DOM event root interface. */
export interface EventRoot {
  /** Reads and pops all events in queue. */
  readEvents(): DomEvent[];
}

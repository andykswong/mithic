import { createElement, Fragment, memo, type FC, type ReactNode } from 'react';
import { isFragment } from './utils.ts';
import type { ElementId } from '@mithic/dom';

const EMPTY_CHILDREN: never[] = [];

/** Virtual DOM {@link Element} renderer component. */
export const ElementRenderer = memo(({ root: element }: ElementRendererProps) => {
  const tag = isFragment(element.tag) ? Fragment : element.tag;
  const children = element.children?.map(renderChild) || EMPTY_CHILDREN;
  return createElement(tag, element.props, ...children);
}) satisfies FC<ElementRendererProps>;

function renderChild(element: ElementRenderState | string): ReactNode {
  return typeof element === 'string' ? element :
    createElement(ElementRenderer, { key: `${element.id}`, root: element });
}

/** Virtual DOM {@link Element} renderer props. */
export interface ElementRendererProps {
  readonly root: ElementRenderState;
}

/** Virtual DOM {@link Element} rendering state. */
export interface ElementRenderState {
  /**  The element tag. */
  tag: string;

  /** The element ID. */
  id: ElementId;

  /** The element properties. */
  props: ElementRenderProps;

  /** The list of children. */
  children?: (ElementRenderState | string)[];
}

/** The element properties. */
export type ElementRenderProps = Record<string, unknown>;

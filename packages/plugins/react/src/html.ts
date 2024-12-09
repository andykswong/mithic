import { HtmlStringRootProvider, type Element, type ElementId, type RootProvider } from '@mithic/dom';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ElementRenderer } from './component.ts';
import { replaceRenderState } from './patch.ts';

/** React HTML string {@link RootProvider}. */
export class ReactHtmlStringRootProvider extends HtmlStringRootProvider implements RootProvider {
  protected override renderToString(_: string, elements: Map<ElementId, Element>, root: ElementId): string {
    const rootState = replaceRenderState(undefined, elements, root);
    return rootState ? renderToString(createElement(ElementRenderer, { root: rootState })) : '';
  }
}

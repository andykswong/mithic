import jsdom from 'global-jsdom';
import { describe, it } from 'node:test';
import { render } from '@testing-library/react';
import { prettyDOM } from '@testing-library/dom';
import { createElement } from 'react';
import { ElementRenderer, type ElementRenderState } from './component.ts';

jsdom();

describe('ElementRenderer', () => {
  it('renders correctly', (t) => {
    const root: ElementRenderState = {
      tag: 'h1',
      id: 1n,
      props: {
        className: 'title',
      },
      children: [
        { tag: 'span', id: 2n, props: { style: { color: 'red' } }, children: ['hello, '] },
        'world!',
      ],
    };

    const result = render(createElement(ElementRenderer, { root }));
    t.assert.snapshot(result.container.firstElementChild!, { serializers: [prettyDOM] });
  });

  it('supports fragment', (t) => {
    const root: ElementRenderState = {
      tag: 'fragment',
      id: 1n,
      props: {
        'data-id': '1',
      },
      children: [
        { tag: 'span', id: 2n, props: { style: { color: 'red' } }, children: ['hello, '] },
        'world!',
      ],
    };

    const result = render(createElement(ElementRenderer, { root }));
    t.assert.snapshot(result.container, { serializers: [prettyDOM] });
  });
});

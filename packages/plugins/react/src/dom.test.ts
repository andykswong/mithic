import jsdom from 'global-jsdom';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { dispose } from '@mithic/commons';
import { ElementChildType, ValueType, type Element, type Root } from '@mithic/dom';
import { prettyDOM, within } from '@testing-library/dom';
import { ReactDomRootProvider } from './dom.ts';

jsdom();

const ROOT = 'container';

describe('ReactDomRootProvider', () => {
  let provider: ReactDomRootProvider;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    provider = new ReactDomRootProvider({
      getRoot: (id) => id === ROOT ? container : undefined,
    });
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  describe('create', () => {
    it('should return undefined for unaccepted root ID', () => {
      const root = provider.create('noop');
      assert.strictEqual(root, undefined);
    });
  });

  describe('render', () => {
    let root: Root;

    beforeEach(() => {
      root = provider.create(ROOT)!;
    });

    afterEach(() => {
      dispose(root);
    });

    it('renders correctly', async (t) => {
      const elements = createHelloWorldElements();
      root.render(elements, elements[0].id);

      await within(container).findByText(/hello/i);
      t.assert.snapshot(container.firstElementChild, { serializers: [prettyDOM] });
    });

    it('re-renders correctly', async (t) => {
      const elements = createHelloWorldElements();
      root.render(elements, elements[0].id);
      await within(container).findByText(/hello/i);

      const newElements = [
        {
          tag: 'h1',
          id: 1n,
          props: [
            ['id', { tag: ValueType.String, val: 'test' }],
            ['class', { tag: ValueType.String, val: 'title newClass' }],
          ],
          style: [
            ['display', { tag: ValueType.String, val: 'inline-block' }],
            ['height', { tag: ValueType.Uint32, val: 50 }],
          ],
          children: [
            { tag: ElementChildType.Text, val: 'New ' },
            { tag: ElementChildType.Element, val: 2n },
            { tag: ElementChildType.Text, val: 'world~' },
          ],
        },
        {
          tag: 'span',
          id: 2n,
          style: [
            ['color', { tag: ValueType.String, val: 'red' }]
          ],
          children: [
            { tag: ElementChildType.Text, val: 'hello, ' }
          ]
        },
      ] satisfies Element[];

      root.render(newElements, newElements[0].id);
      await within(container).findByText(/New/i);

      t.assert.snapshot(container.firstElementChild, { serializers: [prettyDOM] });
    });
  });

  describe('update', () => {
    let root: Root;

    beforeEach(() => {
      root = provider.create(ROOT)!;
    });

    afterEach(() => {
      dispose(root);
    });

    it('updates correctly', async (t) => {
      const elements = createHelloWorldElements();
      root.render(elements, elements[0].id);
      await within(container).findByText(/hello/i);

      const patches = [
        {
          id: 1n,
          props: [
            ['id', { tag: ValueType.String, val: 'test' }],
            ['class', { tag: ValueType.String, val: 'title newClass' }],
          ],
          children: [
            { tag: ElementChildType.Text, val: 'New ' },
            { tag: ElementChildType.Element, val: 2n },
            { tag: ElementChildType.Text, val: 'world~' },
          ],
        },
        {
          id: 2n,
          style: [
            ['color', { tag: ValueType.String, val: 'blue' }],
          ],
        },
      ] satisfies Element[];

      root.update(patches);
      await within(container).findByText(/New/i);

      t.assert.snapshot(container.firstElementChild, { serializers: [prettyDOM] });
    });
  });
});

function createHelloWorldElements() {
  return [
    {
      tag: 'h1',
      id: 1n,
      props: [
        ['id', { tag: ValueType.String, val: 'test' }],
        ['class', { tag: ValueType.String, val: 'title' }],
      ],
      style: [
        ['display', { tag: ValueType.String, val: 'block' }],
      ],
      children: [
        { tag: ElementChildType.Element, val: 2n },
        { tag: ElementChildType.Text, val: 'world!' },
      ],
    },
    {
      tag: 'span',
      id: 2n,
      style: [
        ['color', { tag: ValueType.String, val: 'red' }],
      ],
      children: [
        { tag: ElementChildType.Text, val: 'hello, ' }
      ]
    },
  ] satisfies Element[];
}

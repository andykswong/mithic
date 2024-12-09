import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Element, ElementChildType, ValueType } from '@mithic/dom';
import { ReactHtmlStringRootProvider } from './html.ts';

const ROOT = 'body';

describe('ReactHtmlStringRootProvider', () => {
  let provider: ReactHtmlStringRootProvider;
  let outputs: [string, string][] = [];

  beforeEach(() => {
    outputs = [];
    provider = new ReactHtmlStringRootProvider({
      accept: (id) => id === ROOT,
      write: (identifier, html) => {
        outputs.push([identifier, html]);
      },
    });
  });

  describe('create', () => {
    it('should return undefined for unaccepted root ID', () => {
      const root = provider.create('noop');
      assert.strictEqual(root, undefined);
    });
  });

  describe('render', () => {
    it('should render virtual DOM to HTML string', (t) => {
      const elements = createHelloWorldElements();
      const root = provider.create(ROOT);
      root?.render(elements, elements[0].id);
      t.assert.snapshot(outputs);
    });
  });

  describe('update', () => {
    it('should render patched virtual DOM to HTML string', (t) => {
      const elements = createHelloWorldElements();
      const root = provider.create(ROOT);
      root?.render(elements, elements[0].id);
      root?.update([
        {
          id: 1n,
          props: [
            ['id', { tag: ValueType.String, val: 'test' }],
            ['class', { tag: ValueType.String, val: 'container newClass' }],
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
          id: 2n,
          style: [
            ['color', { tag: ValueType.String, val: 'red' }]
          ],
        },
      ]);
      assert.strictEqual(outputs.length, 2);
      t.assert.snapshot(outputs[1]);
    });
  });
});

function createHelloWorldElements() {
  return [
    {
      tag: 'div',
      id: 1n,
      props: [
        ['id', { tag: ValueType.String, val: 'test' }],
        ['class', { tag: ValueType.String, val: 'container' }],
      ],
      style: [
        ['width', { tag: ValueType.String, val: '100%' }],
        ['height', { tag: ValueType.Int32, val: 50 }],
      ],
      children: [
        { tag: ElementChildType.Element, val: 2n },
        { tag: ElementChildType.Text, val: 'hello, world!' },
      ],
    },
    {
      tag: 'img',
      id: 2n,
      props: [['href', { tag: ValueType.String, val: './test.img' }]]
    },
  ] satisfies Element[];
}


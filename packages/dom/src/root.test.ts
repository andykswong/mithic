import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { dispose } from '@mithic/commons';
import { Dom, type DomEvent, type Element, ElementChildType, HtmlStringRootProvider, type Root as IRoot, type RootProvider, ValueType } from './index.ts';
import { create, type Root } from './root.ts';

const ROOT = 'body';

describe('root', () => {
  let root: Root;
  let outputs: [string, string][] = [];

  beforeEach(() => {
    Dom.provider = new HtmlStringRootProvider({
      accept: (id) => id === ROOT,
      write: (identifier, html) => {
        outputs.push([identifier, html]);
      },
    });
    root = create(ROOT)!;
    outputs = [];
  });

  afterEach(() => {
    dispose(root);
  });

  describe('render', () => {
    it('should render the html string', (t) => {
      const elements = [
        {
          tag: 'div',
          id: 1n,
          props: [['id', { tag: ValueType.String, val: 'test' }], ['class', { tag: ValueType.String, val: 'container' }]],
          children: [{ tag: ElementChildType.Text, val: 'hello, world!' }],
        },
      ] satisfies Element[];

      root.render(elements, 1n);
      t.assert.snapshot(outputs);
    });
  });

  describe('update', () => {
    it('should render updated html string', (t) => {
      const elements = [
        {
          tag: 'div',
          id: 1n,
          props: [['id', { tag: ValueType.String, val: 'test' }], ['class', { tag: ValueType.String, val: 'container' }]],
          children: [{ tag: ElementChildType.Text, val: 'hello, world!' }],
        },
      ] satisfies Element[];

      root.render(elements, 1n);
      root.update([
        { id: 1n, children: [{ tag: ElementChildType.Text, val: 'hello' }, { tag: ElementChildType.Element, val: 2n }] },
        { id: 2n, tag: 'span', children: [{ tag: ElementChildType.Text, val: ', world~' }] }
      ]);

      assert.strictEqual(outputs.length, 2);
      t.assert.snapshot(outputs[1]);
    });
  });

  describe('readEvents', () => {
    it('should return empty array if provider does not support events', () => {
      assert.deepStrictEqual(root.readEvents(), []);
    });

    it('should read events from provider', () => {
      const provider = Dom.provider = createMockRootProvider();
      const rootMock = createMockRoot();
      provider.create.mock.mockImplementation(() => rootMock);
      const events = [{ tag: 'click', target: 1n, data: [] }] satisfies DomEvent[];
      rootMock.readEvents.mock.mockImplementation(() => events);

      root = create(ROOT)!;
      assert.deepStrictEqual(root.readEvents(), events);
    });
  });
});

function createMockRootProvider() {
  return {
    create: mock.fn(),
  } satisfies RootProvider;
}

function createMockRoot() {
  return {
    render: mock.fn(),
    update: mock.fn(),
    readEvents: mock.fn<() => DomEvent[]>(),
  } satisfies IRoot;
}

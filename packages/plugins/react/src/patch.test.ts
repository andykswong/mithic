import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Element, ElementChildType, type ElementId, ValueType } from '@mithic/dom';
import type { ElementRenderState } from './component.ts';
import { replaceRenderState } from './patch.ts';
import { elementEntry } from './utils.ts';

describe('replaceRenderState', () => {
  it('should create new state when input state is undefined', () => {
    const elements = elementMap({
      tag: 'div',
      id: 1n,
    });

    const result = replaceRenderState(undefined, elements, 1n);

    assert.deepStrictEqual(result, {
      tag: 'div',
      id: 1n,
      props: { 'data-id': '1' },
    } satisfies ElementRenderState);
  });

  it('should return existing state when nothing changes', () => {
    const existingState = {
      tag: 'div',
      id: 1n,
      props: { 'data-id': '1' },
    } satisfies ElementRenderState;
    const elements = elementMap({
      tag: 'div',
      id: 1n,
    });

    const result = replaceRenderState(existingState, elements, 1n);

    assert.strictEqual(result, existingState); // same reference
  });

  it('should update tag when it changes', () => {
    const existingState = {
      tag: 'div',
      id: 1n,
      props: { 'data-id': '1' },
    } satisfies ElementRenderState;
    const elements = elementMap({
      tag: 'span',
      id: 1n,
      children: []
    });

    const result = replaceRenderState(existingState, elements, 1n);

    assert.deepStrictEqual(result, {
      tag: 'span',
      id: 1n,
      props: { 'data-id': '1' },
    } satisfies ElementRenderState);
    assert.notStrictEqual(result, existingState); // different reference
  });

  it('should update props when they change', () => {
    const existingState = {
      tag: 'div',
      id: 1n,
      props: { className: 'old', 'data-id': '1' },
    } satisfies ElementRenderState;
    const elements = elementMap({
      tag: 'div',
      id: 1n,
      props: [['class', { tag: ValueType.String, val: 'new' }]],
      children: []
    });

    const result = replaceRenderState(existingState, elements, 1n);

    assert.deepStrictEqual(result?.props, { className: 'new', 'data-id': '1' });
    assert.notStrictEqual(result, existingState); // different reference
  });

  it('should update children when they change', () => {
    const existingState = {
      tag: 'div',
      id: 1n,
      props: {},
    } satisfies ElementRenderState;
    const elements = elementMap(
      { tag: 'div', id: 1n, children: [{ tag: ElementChildType.Element, val: 2n }] },
      { tag: 'span', id: 2n, props: []}
    );

    const result = replaceRenderState(existingState, elements, 1n);

    assert.deepStrictEqual(result?.children, [{ tag: 'span', id: 2n, props: { 'data-id': '2' } }]);
    assert.notStrictEqual(result, existingState); // different reference
  });

  it('should handle element with different ID', () => {
    const existingState = {
      tag: 'div',
      id: 2n,
      props: { 'data-id': '2' },
    } satisfies ElementRenderState;
    const elements = elementMap({ tag: 'div', id: 123n });

    const result = replaceRenderState(existingState, elements, 123n);

    assert.deepStrictEqual(result?.props, { 'data-id': '123' });
    assert.notStrictEqual(result, existingState); // different reference
  });

  it('should preserve child state when key matches', () => {
    const childState = {
      tag: 'span',
      id: 123n,
      props: { 'data-id': '123' },
    } satisfies ElementRenderState;
    const existingState = {
      tag: 'div',
      id: 1n,
      props: { 'data-id': '1' },
      children: [childState, 'text']
    } satisfies ElementRenderState;
    const elements = elementMap(
      { tag: 'div', id: 1n, children: [{ tag: ElementChildType.Element, val: 123n }, { tag: ElementChildType.Text, val: 'text' }] },
      { tag: 'span', id: 123n, props: [], children: [] }
    );

    const result = replaceRenderState(existingState, elements, 1n);

    assert.strictEqual(result?.children?.[0], childState); // same reference for unchanged child
    assert.strictEqual(result, existingState); // same reference
  });
});

function elementMap(...elements: Element[]): Map<ElementId, Element> {
  return new Map(elements.map(elementEntry));
}

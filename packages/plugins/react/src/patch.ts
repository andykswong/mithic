import { arrayCompare } from '@mithic/commons';
import { ElementChildType, ValueType, type Element, type ElementChild, type ElementId, type Props, type Value } from '@mithic/dom';
import type { ElementRenderProps, ElementRenderState } from './component.ts';
import { isEventHandler, isObject, tagName } from './utils.ts';

const DECODER = new TextDecoder();
const EMPTY_ARR: never[] = [];

const KEY = 'key';
const REF = 'ref';
const CLASS = 'class';
const CLASS_NAME = 'className';
const STYLE = 'style';
const ID_ATTR = 'data-id';

/** Replaces {@link ElementRenderState} with new {@link Element}s, returning existing state if nothing changed. */
export function replaceRenderState(
  state: ElementRenderState | undefined,
  elements: ReadonlyMap<ElementId, Element>,
  root: ElementId,
): ElementRenderState | undefined {
  const element = elements.get(root);
  if (!element) { return undefined; }

  let changed = false;
  const tag = tagName(element.tag);
  if (!state) {
    state = { tag, id: root, props: {} };
  }
  if (state.tag !== tag) {
    state.tag = tag;
    changed = true;
  }

  const props = patchRenderProps(state, element.props);
  if (props !== state.props) {
    state.props = props;
    changed = true;
  }

  const style = patchProps(state.props[STYLE], element.style);
  if (style !== state.props[STYLE]) {
    state.props = { ...state.props, [STYLE]: style };
    if (!style) { delete state.props[STYLE]; }
    changed = true;
  }

  const idString = `${element.id}`;
  if (idString !== state.props[ID_ATTR]) {
    state.props = { ...state.props, [ID_ATTR]: idString };
    changed = true;
  }

  const children = replaceRenderChildren(state, elements, element.children);
  if (children !== state.children) {
    state.children = children;
    changed = true;
  }
  if (!state.children) {
    delete state.children;
  }

  return changed ? { ...state } : state;
}

function replaceRenderChildren(
  state: ElementRenderState,
  elements: ReadonlyMap<ElementId, Element>,
  children?: readonly ElementChild[],
): (ElementRenderState | string)[] | undefined {
  if (!children?.length) { return undefined; }

  let changed = false;
  let newChildren = state.children || EMPTY_ARR;
  const oldChildrenState = new Map<ElementId, ElementRenderState>();
  for (const child of newChildren) {
    if (typeof child === 'string') { continue; }
    oldChildrenState.set(child.id, child);
  }

  for (let i = 0; i < children.length; ++i) {
    const entry = children[i];
    let newChild: ElementRenderState | string;
    if (entry.tag === ElementChildType.Text) {
      newChild = entry.val;
    } else {
      const child = elements.get(entry.val);
      const childState = child && oldChildrenState.get(child.id);
      newChild = replaceRenderState(childState, elements, entry.val) ?? '';
    }
    if (!changed && newChild !== newChildren[i]) {
      newChildren = newChildren.slice(0, i);
      changed = true;
    }
    if (changed) { newChildren.push(newChild); }
  }
  return newChildren;
}

function patchRenderProps(state: ElementRenderState, props?: Props): ElementRenderProps {
  const newProps: ElementRenderProps = {};
  let changed = false;

  for (const [key, value] of (props ?? EMPTY_ARR)) {
    let newValue: unknown;
    if (isEventHandler(key)) {
      continue; // TODO: support event subscription
    }
    switch (key) {
      case REF:
      case STYLE:
      case ID_ATTR:
        continue;
      case CLASS:
      case CLASS_NAME:
        newValue = newProps[CLASS_NAME] = valueAsString(value);
        break;
      default:
        newValue = newProps[key] = patchValue(state.props?.[key], value);
        break;
    }
    if (newValue !== state.props[key]) {
      changed = true;
    }
  }

  if (!changed) {
    for (const key of Object.keys(state.props)) {
      if (key === ID_ATTR || key === KEY || key === STYLE) { continue; }
      if (!newProps[key]) { return newProps; }
    }
    return state.props;
  }
  return newProps;
}

function patchProps(value: unknown, newValue?: Props): Record<string, unknown> | undefined {
  const oldProps = isObject(value) ? value : undefined;
  if (!newValue?.length) { return; }

  const newProps: Record<string, unknown> = {};
  let changed = false;
  for (const entry of newValue) {
    const newEntry = patchValue(oldProps?.[entry[0]], entry[1]);
    changed = changed || newEntry !== oldProps?.[entry[0]];
    newProps[entry[0]] = newEntry;
  }

  if (!changed && oldProps) {
    for (const key of Object.keys(oldProps)) {
      if (!(key in newProps)) { return newProps; }
    }
    return oldProps;
  }
  return newProps;
}

function patchValue(value: unknown, newValue: Value): unknown {
  if (newValue.tag === ValueType.Binary) {
    return (value instanceof Uint8Array && arrayCompare(value, newValue.val) === 0) ?
      value : new Uint8Array(newValue.val);
  }
  return newValue.val;
}

export function valueAsString(value: Value): string {
  switch (value.tag) {
    case ValueType.Binary:
      return DECODER.decode(value.val);
    case ValueType.String:
      return value.val;
    case ValueType.Boolean:
    case ValueType.Int32:
    case ValueType.Int64:
    case ValueType.Uint32:
    case ValueType.Uint64:
    case ValueType.Float:
    case ValueType.Double:
      return `${value.val}`;
  }
  return '';
}

import type { Root, RootProvider } from '../service.ts';
import { ElementChildType, type Element, type ElementChild, type ElementId, type Props } from '../types.ts';
import {
  attrName, elementEntry, encodeValue, eventName, filterObject, isFragment, isNumeric, isVoidTag, tagName,
  valueAsString
} from './utils.ts';

const ID_ATTR = 'data-id';
const STYLE = 'style';

/** Simple {@link RootProvider} HTML string writer. */
export class HtmlStringRootProvider implements RootProvider {
  private readonly accept: (id: string) => boolean;
  private readonly write: (id: string, html: string) => void;
  private state?: Map<ElementId, Element>;
  private root: ElementId = 0n;

  public constructor({
    accept = () => true,
    write = (_, html) => console.log(html),
  }: HtmlStringRootProviderOptions = {}) {
    this.accept = accept;
    this.write = write;
  }

  public create(identifier: string): Root | undefined {
    if (!this.accept(identifier)) {
      return;
    }
    return {
      render: (elements: Element[], root: ElementId) => {
        this.state = new Map(elements.map(elementEntry));
        this.root = root;
        const html = this.renderToString(identifier, this.state, this.root);
        this.write(identifier, html);
      },
      update: (patches: Element[]) => {
        if (!this.state) {
          return;
        }
        for (const patch of patches) {
          const element = this.state.get(patch.id);
          if (element) {
            Object.assign(element, filterObject(patch));
          } else {
            this.state.set(patch.id, patch);
          }
        }
        // TODO: remove inaccessible elements
        const html = this.renderToString(identifier, this.state, this.root);
        this.write(identifier, html);
      },
    } satisfies Root;
  }

  protected renderToString(_target: string, elements: Map<ElementId, Element>, root: ElementId): string {
    return renderToString(elements, root);
  }
}

export interface HtmlStringRootProviderOptions {
  /** Returns if given root ID is supported. */
  accept?: (id: string) => boolean;

  /** HTML string writer. */
  write?: (id: string, html: string) => void;
}

/** Renders Virtual DOM element to string. */
function renderToString(elements: ReadonlyMap<ElementId, Element>, id: ElementId): string {
  const element = elements.get(id);
  if (!element) { return ''; }

  const tag = tagName(element.tag);
  if (isFragment(tag)) {
    return renderChildren(elements, element.children);
  }

  const attributes = renderAttributes(element).join(' ');
  if (isVoidTag(tag)) {
    return `<${tag} ${attributes}/>`;
  }

  const children = renderChildren(elements, element.children);
  return `<${tag} ${attributes}>${children}</${element.tag}>`;
}

function renderAttributes(element: Element): string[] {
  const attributes = [];
  if (element.id) {
    attributes.push(`${ID_ATTR}="${element.id}"`);
  }
  if (element.props) {
    for (const [key, value] of element.props) {
      const name = attrName(key);
      if (eventName(name)) {
        continue;
      }
      attributes.push(`${name}="${encodeValue(valueAsString(value))}"`);
    }
  }
  if (element.style) {
    attributes.push(`${STYLE}="${encodeValue(renderStyle(element.style))}"`);
  }
  return attributes;
}

function renderStyle(style: Props): string {
  const result: string[] = [];
  for (const [key, value] of style) {
    const valueString = isNumeric(value) ? `${value.val}px` : valueAsString(value);
    result.push(`${key}:${valueString}`);
  }
  return result.join(';');
}

function renderChildren(
  elements: ReadonlyMap<ElementId, Element>,
  children: readonly ElementChild[] | undefined
): string {
  if (!children) { return ''; }
  const result: string[] = [];
  for (const child of children) {
    if (child.tag === ElementChildType.Text) {
      result.push(child.val);
    } else {
      const element = elements.get(child.val);
      if (element) {
        result.push(renderToString(elements, element.id));
      }
    }
  }
  return result.join('');
}

/** A virtual DOM element. */
export interface Element {
  /** The unique ID of element. */
  readonly id: ElementId;

  /** The element tag. */
  readonly tag?: string;

  /** The element properties. */
  readonly props?: Props;

  /** The element styles. */
  readonly style?: Props;

  /** The list of children. */
  readonly children?: readonly ElementChild[];
}

/** Id of an element. */
export type ElementId = bigint;

/** Virtual DOM element properties. */
export type Props = readonly [key: string, value: Value][];

/** Type of {@link Value}. */
export const ValueType = {
  Null: 'null',
  Int32: 'int32',
  Int64: 'int64',
  Uint32: 'uint32',
  Uint64: 'uint64',
  Float: 'float',
  Double: 'double',
  String: 'string',
  Boolean: 'boolean',
  Binary: 'binary',
} as const;

export type ValueType = typeof ValueType[keyof typeof ValueType];

/** Primitive value. */
export type Value = (
  { readonly tag: typeof ValueType.Null, readonly val?: never } |
  { readonly tag: typeof ValueType.Int32 | typeof ValueType.Uint32, readonly val: number } |
  { readonly tag: typeof ValueType.Int64 | typeof ValueType.Uint64, readonly val: bigint } |
  { readonly tag: typeof ValueType.Float | typeof ValueType.Double, readonly val: number } |
  { readonly tag: typeof ValueType.String, readonly val: string } |
  { readonly tag: typeof ValueType.Boolean, readonly val: boolean } |
  { readonly tag: typeof ValueType.Binary, readonly val: Uint8Array }
);

/** Type of {@link ElementChild}. */
export const ElementChildType = {
  Element: 'element',
  Text: 'text',
} as const;

export type ElementChildType = typeof ElementChildType[keyof typeof ElementChildType];

/** Element child. */
export type ElementChild = (
  { readonly tag: typeof ElementChildType.Element, readonly val: bigint } |
  { readonly tag: typeof ElementChildType.Text, readonly val: string }
);

/** A virtual DOM event. */
export interface DomEvent {
  /**  The event type tag. */
  readonly tag: string;

  /** The event target element ID. */
  readonly target: ElementId;

  /** The event data. */
  readonly data: Props;
}

/** DOM event listener. */
export interface DomEventListener {
  /** Callback for new DOM event. */
  onDomEvent(): void;
}

/** Fully-qualified name for incoming handler. */
export const ListenerFQN = 'mithic:dom/listener@0.3.0';

/** Guest component that interacts with DOM. */
export interface DomGuest {
  /** Incoming message handler. */
  [ListenerFQN]?: DomEventListener;
}

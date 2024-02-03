import { MaybeAsyncMap, MaybeAsyncMapBatch } from '../map.ts';
import { RangeQueryOptions, RangeQueryable, rangeQueryable } from '../range.ts';
import { SyncMapBatchAdapter } from './batchmap.ts';

/** An in-memory B-tree structure that implements the Map interface. */
export class BTreeMap<K, V>
  extends SyncMapBatchAdapter<K, V>
  implements MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, Map<K, V>, RangeQueryable<K, V>, Iterable<[K, V]>
{
  protected children: BTreeMap<K, V>[] = [];
  protected nodeKeys: K[] = [];
  protected nodeValues: V[] = [];

  public constructor(
    /** Order of the tree, which is the maximum branching factor / number of children of a node. Must be >= 2. */
    public readonly order = 5,
    /** Function that defines the sort order of keys. */
    protected readonly compare: (a: K, b: K) => number = (a, b) => (a < b ? -1 : b < a ? 1 : 0),
  ) {
    super();
  }

  /**
   * Returns the number of elements in the tree.
   * Note that this is an O(N) operation that counts the number of elements in each tree node.
   */
  public get size(): number {
    let count = this.nodeKeys.length;
    for (let i = 0; i < this.children.length; i++) {
      count += this.children[i].size;
    }
    return count;
  }

  public clear(): void {
    this.nodeKeys.length = 0;
    this.nodeValues.length = 0;
    this.children.length = 0;
  }

  public delete(key: K): boolean {
    const path: BTreeMap<K, V>[] = [];
    let nodeIndex = -1;
    let found = false;

    // find the node with the key to delete, recording the node path
    for (
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      let node: BTreeMap<K, V> = this;
      node && !found;
      (
        [nodeIndex, found] = node.findKeyIndex(key),
        path.push(node),
        node = node.children[nodeIndex]
      )
    );

    if (!found) { // key not found
      return false;
    }

    // actually delete the key
    const node = path[path.length - 1];
    if (!node.children.length) {
      // leaf node, delete matching key directly
      node.nodeKeys.splice(nodeIndex, 1);
      node.nodeValues.splice(nodeIndex, 1);
    } else {
      // internal node, replace with predecessor element
      let predecessor = node.children[nodeIndex];
      path.push(predecessor);
      while (predecessor.children.length) {
        predecessor = predecessor.children[predecessor.children.length - 1];
        path.push(predecessor);
      }
      node.nodeKeys[nodeIndex] = predecessor.nodeKeys.pop() as K;
      node.nodeValues[nodeIndex] = predecessor.nodeValues.pop() as V;
    }

    // rebalance deficient nodes all the way up to the root
    for (
      let node = path.pop(), parent = path.pop();
      node && node.nodeSize < this.minKeys && parent;
      node = parent, parent = path.pop()
    ) {
      const index = parent.children.indexOf(node);
      const nextSibling = parent.children[index + 1];
      const prevSibling = parent.children[index - 1];

      if (nextSibling && (
        nextSibling.nodeSize > this.minKeys ||
        (this.order === 2 && nextSibling.nodeSize) // special case for order 2 with empty left node
      )) {
        // case 1. borrow from right sibling with extra elements
        node.nodeKeys.push(parent.nodeKeys[index]);
        node.nodeValues.push(parent.nodeValues[index]);
        parent.nodeKeys[index] = nextSibling.nodeKeys.shift() as K;
        parent.nodeValues[index] = nextSibling.nodeValues.shift() as V;
        const borrowedChild = nextSibling.children.shift();
        borrowedChild && node.children.push(borrowedChild);

        // handle special case of order 2 b-tree, where right node has 1 child and no key remaining
        if (nextSibling.children.length === 1) {
          nextSibling.assign(nextSibling.children[0]);
        }
      } else if (prevSibling && prevSibling.nodeSize > this.minKeys) {
        // case 2. borrow from left sibling with extra elements
        node.nodeKeys.unshift(parent.nodeKeys[index - 1]);
        node.nodeValues.unshift(parent.nodeValues[index - 1]);
        parent.nodeKeys[index - 1] = prevSibling.nodeKeys.pop() as K;
        parent.nodeValues[index - 1] = prevSibling.nodeValues.pop() as V;
        const borrowedChild = prevSibling.children.pop();
        borrowedChild && node.children.unshift(borrowedChild);
      } else {
        // case 3. both siblings don't have enough elements, merge with one of them
        // b-tree node must have >= 2 children, so either prevSibling or nextSibling must exist
        if (prevSibling) {
          prevSibling.nodeKeys.push(parent.nodeKeys[index - 1], ...node.nodeKeys);
          prevSibling.nodeValues.push(parent.nodeValues[index - 1], ...node.nodeValues);
          prevSibling.children.push(...node.children);
          parent.nodeKeys.splice(index - 1, 1);
          parent.nodeValues.splice(index - 1, 1);
          parent.children.splice(index, 1);
        } else {
          node.nodeKeys.push(parent.nodeKeys[index], ...nextSibling.nodeKeys);
          node.nodeValues.push(parent.nodeValues[index], ...nextSibling.nodeValues);
          node.children.push(...nextSibling.children);
          parent.nodeKeys.splice(index, 1);
          parent.nodeValues.splice(index, 1);
          parent.children.splice(index + 1, 1);
        }

        // for root node / order 2, parent may now be empty. collapse tree if so
        if (parent.children.length === 1) {
          parent.assign(parent.children[0]);
          parent.splitIfFull(); // for order 2 with 1 parent and 1 left node, parent will overflow
        }
      }
    }

    return true;
  }

  public forEach(callbackfn: (value: V, key: K, tree: BTreeMap<K, V>) => void, thisArg?: unknown): void {
    for (let i = 0; i < this.nodeKeys.length; ++i) {
      this.children[i]?.forEach(callbackfn, thisArg);
      callbackfn.call(thisArg, this.nodeValues[i], this.nodeKeys[i], this);
    }
    this.children[this.children.length - 1]?.forEach(callbackfn, thisArg);
  }

  public get(key: K): V | undefined {
    const [index, match] = this.findKeyIndex(key);
    if (match) {
      return this.nodeValues[index];
    }

    return this.children[index]?.get(key);
  }

  public has(key: K): boolean {
    return this.get(key) !== void 0;
  }

  public set(key: K, value: V): this {
    const path: BTreeMap<K, V>[] = [];

    // insert at leaf node, recording the node path
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    for (let node: BTreeMap<K, V> = this, child = node, done = false; !done; path.push(node), node = child) {
      const [index, match] = node.findKeyIndex(key);

      if (match) {
        // key found, update value and return directly
        node.nodeValues[index] = value;
        return this;
      }

      child = node.children[index];
      if (!child) {
        // leaf node, insert key/value at the correct position
        node.nodeKeys.splice(index, 0, key);
        node.nodeValues.splice(index, 0, value);
        done = true;
      }
    }

    // split full nodes all the way up to the root
    for (
      let node = path.pop(), parent = path.pop();
      node?.splitIfFull() && parent;
      node = parent, parent = path.pop()
    ) {
      // node got split, merge it into parent and continue
      const index = parent.children.indexOf(node);
      parent.nodeKeys.splice(index, 0, ...node.nodeKeys);
      parent.nodeValues.splice(index, 0, ...node.nodeValues);
      parent.children.splice(index, 1, ...node.children);
    }

    return this;
  }

  /** Queries entries in this map. */
  public * entries(options?: RangeQueryOptions<K>): IterableIterator<[K, V]> {
    const bounds = getBounds(this.compare, options);
    if (!bounds) {
      return;
    }

    yield* (options?.reverse ?
      this.reverseIterate(...bounds, options?.limit ?? Infinity) :
      this.iterate(...bounds, options?.limit ?? Infinity)
    );
  }

  /** Queries keys in this map. */
  public * keys(options?: RangeQueryOptions<K>): IterableIterator<K> {
    for (const [key,] of this.entries(options)) {
      yield key;
    }
  }

  /** Queries values in this map. */
  public * values(options?: RangeQueryOptions<K>): IterableIterator<V> {
    for (const [, value] of this.entries(options)) {
      yield value;
    }
  }

  public [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return BTreeMap.name;
  }

  public get [rangeQueryable](): true {
    return true;
  }

  /**
   * Returns the number of elements in the current node.
   */
  public get nodeSize(): number {
    return this.nodeKeys.length;
  }

  /** Returns the minimum number of keys for a non-root node. */
  protected get minKeys(): number {
    return (this.order / 2) | 0;
  }

  /** Assigns RHS to this tree. */
  protected assign(rhs: BTreeMap<K, V>): void {
    this.nodeKeys = rhs.nodeKeys;
    this.nodeValues = rhs.nodeValues;
    this.children = rhs.children;
  }

  /**
   * Finds the index at this node that given key should be inserted at,
   * and whether there is an existing `match`ing key at node.
   */
  protected findKeyIndex(key: K): [index: number, match: boolean] {
    for (let i = 0; i < this.nodeKeys.length; ++i) {
      const cmp = this.compare(key, this.nodeKeys[i]);
      if (cmp <= 0) {
        return [i, cmp === 0];
      }
    }
    return [this.nodeKeys.length, false];
  }

  /** Splits node if it exceeds the max number of keys (order - 1). */
  protected splitIfFull(node: BTreeMap<K, V> = this): boolean {
    if (node.nodeSize < node.order) {
      return false;
    }

    const mid = node.minKeys;

    const left = new BTreeMap<K, V>(node.order, node.compare);
    left.nodeKeys = node.nodeKeys.slice(0, mid);
    left.nodeValues = node.nodeValues.slice(0, mid);
    left.children = node.children.slice(0, mid + 1);

    const right = new BTreeMap<K, V>(node.order, node.compare);
    right.nodeKeys = node.nodeKeys.slice(mid + 1);
    right.nodeValues = node.nodeValues.slice(mid + 1);
    right.children = node.children.slice(mid + 1);

    // Handle special case of order 2 b-tree with empty right nodes
    if (right.children.length === 1) {
      right.assign(right.children[0]);
    }

    node.nodeKeys = [node.nodeKeys[mid]];
    node.nodeValues = [node.nodeValues[mid]];
    node.children = [left, right];

    return true;
  }

  /** Iterates through given bounds */
  protected * iterate(
    lower: K | undefined, upper: K | undefined, lowerInclusive: boolean, upperInclusive: boolean, limit: number,
  ): IterableIterator<[K, V]> {
    let index = 0;
    if (lower !== void 0) {
      let match = false;
      [index, match] = this.findKeyIndex(lower);

      if (match) {
        if (lowerInclusive) {
          if (limit-- <= 0) return;
          yield [this.nodeKeys[index], this.nodeValues[index]];
        }
        ++index;
      }
    }

    for (; index < this.nodeSize; ++index) {
      const child = this.children[index];
      if (child) {
        for (const entry of child.iterate(lower, upper, lowerInclusive, upperInclusive, limit)) {
          if (limit-- <= 0) return;
          yield entry;
        }
      }

      const key = this.nodeKeys[index];
      if (upper !== void 0) {
        const cmp = this.compare(key, upper);
        if (cmp >= 0) {
          if (cmp === 0 && upperInclusive && limit > 0) {
            yield [key, this.nodeValues[index]];
          }
          return;
        }
      }

      if (limit-- <= 0) return;
      yield [key, this.nodeValues[index]];
    }

    const lastChild = this.children[index];
    if (lastChild) {
      yield* lastChild.iterate(lower, upper, lowerInclusive, upperInclusive, limit);
    }
  }

  /** Reverse iterates through given bounds */
  protected * reverseIterate(
    lower: K | undefined, upper: K | undefined, lowerInclusive: boolean, upperInclusive: boolean, limit: number,
  ): IterableIterator<[K, V]> {
    let index = this.nodeSize - 1;
    if (upper !== void 0) {
      let match = false;
      [index, match] = this.findKeyIndex(upper);

      if (match && upperInclusive) {
        if (limit-- <= 0) return;
        yield [this.nodeKeys[index], this.nodeValues[index]];
      }
      --index;
    }

    for (; index >= 0; --index) {
      const child = this.children[index + 1];
      if (child) {
        for (const entry of child.reverseIterate(lower, upper, lowerInclusive, upperInclusive, limit)) {
          if (limit-- <= 0) return;
          yield entry;
        }
      }

      const key = this.nodeKeys[index];
      if (lower !== void 0) {
        const cmp = this.compare(key, lower);
        if (cmp <= 0) {
          if (cmp === 0 && lowerInclusive && limit > 0) {
            yield [key, this.nodeValues[index]];
          }
          return;
        }
      }

      if (limit-- <= 0) {
        return;
      }
      yield [key, this.nodeValues[index]];
    }

    const firstChild = this.children[0];
    if (firstChild) {
      yield* firstChild.reverseIterate(lower, upper, lowerInclusive, upperInclusive, limit);
    }
  }
}

function getBounds<K>(
  compare: (a: K, b: K) => number,
  options?: RangeQueryOptions<K>
): [lower: K | undefined, upper: K | undefined, lowerInclusive: boolean, upperInclusive: boolean] | undefined {
  const lower = options?.lower;
  const upper = options?.upper;
  const lowerInclusive = !(options?.lowerOpen);
  const upperInclusive = !(options?.upperOpen ?? true);

  if (lower !== void 0 && upper !== void 0) {
    const cmp = compare(lower, upper);
    if (cmp > 0 || (cmp === 0 && (!lowerInclusive || !upperInclusive))) {
      return; // invalid bound
    }
  }

  return [lower, upper, lowerInclusive, upperInclusive];
}

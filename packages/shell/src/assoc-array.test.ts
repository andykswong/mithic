/* eslint-disable @typescript-eslint/no-explicit-any -- assoc-array tests use a minimal mock kernel */
import { expect, test } from 'vitest';
import { Executor } from './executor.ts';

function mk(ctx: Record<string, unknown> = {}) {
  const k = { async spawn() { return { pid: 1 }; }, async wait(p: number) { return { pid: p, code: 0 }; } };
  let out = ''; let err = '';
  const ex = new Executor(k as any, { cwd: '/', env: {}, ...ctx } as any, {
    onStdout: (s) => { out += s; }, onStderr: (s) => { err += s; }, resolve: (n) => n,
  });
  return { ex, get out() { return out; }, get err() { return err; } };
}

test('declare -A + element assignment + ${a[key]} access', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[fruit]=apple\na[veg]=carrot\necho "${a[fruit]} ${a[veg]}"');
  expect(h.out.trim()).toBe('apple carrot');
});

test('string keys are not treated as numeric indices', async () => {
  const h = mk();
  // A numeric index into an associative array uses the literal "0" key, not slot 0.
  await h.ex.exec('declare -A m\nm[zero]=z\nm[0]=numeric\necho "${m[zero]}:${m[0]}"');
  expect(h.out.trim()).toBe('z:numeric');
});

test('${!a[@]} lists the keys', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[x]=1\na[y]=2\nfor k in "${!a[@]}"; do echo "key:$k"; done');
  // keys x and y both appear (order is unspecified, so just check membership)
  expect(h.out).toContain('key:x');
  expect(h.out).toContain('key:y');
});

test('${a[@]} lists the values', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[one]=1\na[two]=2\nfor v in "${a[@]}"; do echo "val:$v"; done');
  expect(h.out).toContain('val:1');
  expect(h.out).toContain('val:2');
});

test('${#a[@]} counts the entries', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[p]=1\na[q]=2\na[r]=3\necho "${#a[@]}"');
  expect(h.out.trim()).toBe('3');
});

test('reassigning an existing key overwrites it', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[k]=first\na[k]=second\necho "${a[k]}"');
  expect(h.out.trim()).toBe('second');
});

test('missing key expands to empty', async () => {
  const h = mk();
  await h.ex.exec('declare -A a\na[present]=yes\necho "[${a[absent]}]"');
  expect(h.out.trim()).toBe('[]');
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { installPolyfill, createInstantiateCore } from '@mithic/wasm-transpile';
import type { ComponentExit } from '@mithic/wasip2/cli/exit';
import type { InputStreamHandler, OutputStreamHandler } from '@mithic/io/io';
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { FsDescriptorHandler } from '@mithic/wasip2/filesystem/fs-handler';
import { MemoryFsProvider, FileSystemRouter } from '@mithic/io/vfs';

const polyfill = installPolyfill();
const variant = polyfill.installed ? 'asyncify' : 'jspi';

const jqEntry = await (variant === 'asyncify'
  ? import('@mithic/jq/component/asyncify')
  : import('@mithic/jq/component/jspi'));

const instantiateCore = createInstantiateCore({ asyncify: polyfill.installed });

type ComponentEntry = { instantiate: (...args: unknown[]) => Promise<{ run: { run: () => Promise<number> } }>; modules: Record<string, string> };

function compileModules(modules: Record<string, string>) {
  return async (path: string) => {
    const uri = modules[path];
    const response = await fetch(uri);
    return WebAssembly.compile(await response.arrayBuffer());
  };
}

function createInputHandler(data: Uint8Array): InputStreamHandler {
  let offset = 0;
  return {
    read(len: number) {
      if (offset >= data.length) return undefined;
      const chunk = data.subarray(offset, offset + len);
      offset += chunk.length;
      return chunk.length > 0 ? chunk : undefined;
    },
    blockingRead(len: number) {
      if (offset >= data.length) return new Uint8Array(0);
      const chunk = data.subarray(offset, offset + len);
      offset += chunk.length;
      return chunk;
    },
  };
}

function createOutputHandler(chunks: Uint8Array[]): OutputStreamHandler {
  return {
    checkWrite() { return 65536; },
    write(data: Uint8Array) { chunks.push(new Uint8Array(data)); },
    flush() {},
  };
}

async function runJq(args: string[], stdin: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stdinBytes = new TextEncoder().encode(stdin);
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const memFs = new MemoryFsProvider();
  memFs.mkdir('/tmp');
  const vfs = new FileSystemRouter();
  await vfs.mount('/', memFs);

  const shim = new WASIShim({
    async: true,
    sandbox: {
      preopens: { '/': new Descriptor(new FsDescriptorHandler(vfs, '/')) },
      env: {},
      args: ['jq', ...args],
      cwd: '/tmp',
      stdin: createInputHandler(stdinBytes),
      stdout: createOutputHandler(stdoutChunks),
      stderr: createOutputHandler(stderrChunks),
    },
  });

  let exit = 0;
  try {
    const entry = jqEntry as unknown as ComponentEntry;
    const instance = await entry.instantiate(
      compileModules(entry.modules),
      shim.getImportObject(),
      instantiateCore,
    );
    exit = (await instance.run.run()) ?? 0;
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'exitError' in e) {
      exit = (e as ComponentExit).code ?? 1;
    } else {
      throw e;
    }
  } finally {
    shim[Symbol.dispose]();
  }

  const stdout = new TextDecoder().decode(concatUint8Arrays(stdoutChunks));
  const stderr = new TextDecoder().decode(concatUint8Arrays(stderrChunks));
  return { stdout, stderr, exit };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

describe('jq - JSON parsing', () => {
  it('parses valid JSON object', async () => {
    const { stdout, exit } = await runJq(['.'], '{"a":1}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{\n  "a": 1\n}');
  });

  it('parses nested structures', async () => {
    const { stdout, exit } = await runJq(['.a.b'], '{"a":{"b":42}}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '42');
  });

  it('handles unicode escapes', async () => {
    const { stdout, exit } = await runJq(['-r', '.'], '"hell\\u006f"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('handles large numbers', async () => {
    const { stdout, exit } = await runJq(['.'], '12345678901234567');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.trim().length > 0);
  });

  it('handles empty input gracefully', async () => {
    const { stdout, exit } = await runJq(['-n', 'null'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'null');
  });
});

describe('jq - Basic filters', () => {
  it('identity', async () => {
    const { stdout, exit } = await runJq(['.'], '42');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '42');
  });

  it('field access', async () => {
    const { stdout, exit } = await runJq(['.name'], '{"name":"test","x":1}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"test"');
  });

  it('nested access', async () => {
    const { stdout, exit } = await runJq(['.a.b.c'], '{"a":{"b":{"c":99}}}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '99');
  });

  it('array index', async () => {
    const { stdout, exit } = await runJq(['.[2]'], '[10,20,30,40]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '30');
  });

  it('negative array index', async () => {
    const { stdout, exit } = await runJq(['.[-1]'], '[10,20,30]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '30');
  });

  it('array slice', async () => {
    const { stdout, exit } = await runJq(['-c', '.[1:3]'], '[0,1,2,3,4]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2]');
  });
});

describe('jq - Iterators', () => {
  it('array iterator .[]', async () => {
    const { stdout, exit } = await runJq(['.[]'], '[1,2,3]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2\n3');
  });

  it('object iterator .[]', async () => {
    const { stdout, exit } = await runJq(['.[]'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2');
  });

  it('recursive descent ..', async () => {
    const { stdout, exit } = await runJq(['-c', '[.. | numbers]'], '{"a":{"b":1},"c":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2]');
  });
});

describe('jq - Operators', () => {
  it('pipe', async () => {
    const { stdout, exit } = await runJq(['.a | . + 1'], '{"a":5}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '6');
  });

  it('comma (multiple outputs)', async () => {
    const { stdout, exit } = await runJq(['.a,.b'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1\n2');
  });

  it('arithmetic', async () => {
    const { stdout, exit } = await runJq(['-n', '2 + 3 * 4'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '14');
  });

  it('modulo', async () => {
    const { stdout, exit } = await runJq(['-n', '10 % 3'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1');
  });

  it('comparison', async () => {
    const { stdout, exit } = await runJq(['-n', '3 > 2'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'true');
  });

  it('boolean operators', async () => {
    const { stdout, exit } = await runJq(['-n', 'true and false'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'false');
  });

  it('alternative operator //', async () => {
    const { stdout, exit } = await runJq(['.foo // "default"'], 'null');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"default"');
  });
});

describe('jq - String operations', () => {
  it('string interpolation', async () => {
    const { stdout, exit } = await runJq(['-r', '"hello \\(.name)"'], '{"name":"world"}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello world');
  });

  it('split', async () => {
    const { stdout, exit } = await runJq(['-c', 'split(",")'], '"a,b,c"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '["a","b","c"]');
  });

  it('join', async () => {
    const { stdout, exit } = await runJq(['-r', 'join("-")'], '["a","b","c"]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'a-b-c');
  });

  it('ltrimstr/rtrimstr', async () => {
    const { stdout, exit } = await runJq(['-r', 'ltrimstr("hello ")'], '"hello world"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('ascii_downcase', async () => {
    const { stdout, exit } = await runJq(['-r', 'ascii_downcase'], '"HELLO"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('startswith/endswith', async () => {
    const { stdout, exit } = await runJq(['startswith("he")'], '"hello"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'true');
  });
});

describe('jq - Array operations', () => {
  it('map', async () => {
    const { stdout, exit } = await runJq(['-c', 'map(. * 2)'], '[1,2,3]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[2,4,6]');
  });

  it('select', async () => {
    const { stdout, exit } = await runJq(['-c', '[.[] | select(. > 2)]'], '[1,2,3,4]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[3,4]');
  });

  it('sort_by', async () => {
    const { stdout, exit } = await runJq(['-c', 'sort_by(.x)'], '[{"x":3},{"x":1},{"x":2}]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[{"x":1},{"x":2},{"x":3}]');
  });

  it('group_by', async () => {
    const { stdout, exit } = await runJq(['-c', 'group_by(.k)'], '[{"k":"a","v":1},{"k":"a","v":2},{"k":"b","v":3}]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[[{"k":"a","v":1},{"k":"a","v":2}],[{"k":"b","v":3}]]');
  });

  it('unique', async () => {
    const { stdout, exit } = await runJq(['-c', 'unique'], '[1,2,1,3,2]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2,3]');
  });

  it('flatten', async () => {
    const { stdout, exit } = await runJq(['-c', 'flatten'], '[[1,2],[3,[4]]]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2,3,4]');
  });

  it('add', async () => {
    const { stdout, exit } = await runJq(['add'], '[1,2,3]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '6');
  });

  it('min/max', async () => {
    const { stdout, exit } = await runJq(['min'], '[3,1,2]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '1');
  });

  it('range', async () => {
    const { stdout, exit } = await runJq(['-c', '-n', '[range(5)]'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[0,1,2,3,4]');
  });
});

describe('jq - Object operations', () => {
  it('keys', async () => {
    const { stdout, exit } = await runJq(['-c', 'keys'], '{"b":1,"a":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '["a","b"]');
  });

  it('values', async () => {
    const { stdout, exit } = await runJq(['-c', 'values'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2]');
  });

  it('has', async () => {
    const { stdout, exit } = await runJq(['has("a")'], '{"a":1}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'true');
  });

  it('del', async () => {
    const { stdout, exit } = await runJq(['-c', 'del(.a)'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{"b":2}');
  });

  it('to_entries/from_entries', async () => {
    const { stdout, exit } = await runJq(['-c', 'to_entries'], '{"a":1}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[{"key":"a","value":1}]');
  });

  it('with_entries', async () => {
    const { stdout, exit } = await runJq(['-c', 'with_entries(select(.value > 1))'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{"b":2}');
  });

  it('object construction', async () => {
    const { stdout, exit } = await runJq(['-c', '{x:.a,y:.b}'], '{"a":1,"b":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{"x":1,"y":2}');
  });
});

describe('jq - Control flow', () => {
  it('if-then-else', async () => {
    const { stdout, exit } = await runJq(['if . > 3 then "big" else "small" end'], '5');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"big"');
  });

  it('try-catch', async () => {
    const { stdout, exit } = await runJq(['try error("oops") catch .'], 'null');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"oops"');
  });

  it('reduce', async () => {
    const { stdout, exit } = await runJq(['reduce .[] as $x (0; . + $x)'], '[1,2,3,4,5]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '15');
  });

  it('def (user function)', async () => {
    const { stdout, exit } = await runJq(['def double: . * 2; double'], '5');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '10');
  });
});

describe('jq - Variables', () => {
  it('as binding', async () => {
    const { stdout, exit } = await runJq(['-c', '.a as $x | {doubled: ($x * 2)}'], '{"a":3}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{"doubled":6}');
  });

  it('--arg', async () => {
    const { stdout, exit } = await runJq(['-r', '--arg', 'name', 'world', '$name'], 'null');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'world');
  });

  it('--argjson', async () => {
    const { stdout, exit } = await runJq(['--argjson', 'n', '42', '$n + 1'], 'null');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '43');
  });
});

describe('jq - Format strings', () => {
  it('@base64', async () => {
    const { stdout, exit } = await runJq(['@base64'], '"hello"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"aGVsbG8="');
  });

  it('@base64d', async () => {
    const { stdout, exit } = await runJq(['-r', '@base64d'], '"aGVsbG8="');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello');
  });

  it('@html', async () => {
    const { stdout, exit } = await runJq(['-r', '@html'], '"<b>hi</b>"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '&lt;b&gt;hi&lt;/b&gt;');
  });

  it('@csv', async () => {
    const { stdout, exit } = await runJq(['-r', '@csv'], '["a","b",1]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"a","b",1');
  });

  it('@uri', async () => {
    const { stdout, exit } = await runJq(['-r', '@uri'], '"hello world"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'hello%20world');
  });
});

describe('jq - CLI flags', () => {
  it('-n (null input)', async () => {
    const { stdout, exit } = await runJq(['-n', '1+1'], '');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '2');
  });

  it('-s (slurp)', async () => {
    const { stdout, exit } = await runJq(['-s', '-c', '.'], '1\n2\n3\n');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[1,2,3]');
  });

  it('-S (sort keys)', async () => {
    const { stdout, exit } = await runJq(['-Sc', '.'], '{"z":1,"a":2}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{"a":2,"z":1}');
  });

  it('-e (exit status with truthy value)', async () => {
    const { exit } = await runJq(['-e', '.a'], '{"a":1}');
    assert.strictEqual(exit, 0);
  });

  it('--tab indent', async () => {
    const { stdout, exit } = await runJq(['--tab', '.'], '{"a":1}');
    assert.strictEqual(exit, 0);
    assert.ok(stdout.includes('\t"a"'));
  });
});

describe('jq - Edge cases', () => {
  it('null handling', async () => {
    const { stdout, exit } = await runJq(['.foo'], 'null');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), 'null');
  });

  it('empty array', async () => {
    const { stdout, exit } = await runJq(['-c', '.'], '[]');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '[]');
  });

  it('empty object', async () => {
    const { stdout, exit } = await runJq(['-c', '.'], '{}');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '{}');
  });

  it('length of various types', async () => {
    const { stdout, exit } = await runJq(['length'], '"hello"');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '5');
  });

  it('type builtin', async () => {
    const { stdout, exit } = await runJq(['type'], '42');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '"number"');
  });

  it('optional field access on non-object', async () => {
    const { stdout, exit } = await runJq(['.foo?'], '42');
    assert.strictEqual(exit, 0);
    assert.strictEqual(stdout.trim(), '');
  });
});

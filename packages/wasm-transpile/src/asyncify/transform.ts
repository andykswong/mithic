import binaryen from 'binaryen';

export interface AsyncifyTransformOptions {
  asyncImports?: string[];
  secondaryMemoryPages?: number;
}

export function asyncifyTransform(wasmBytes: Uint8Array, opts?: AsyncifyTransformOptions): Uint8Array {
  const mod = binaryen.readBinary(wasmBytes);
  mod.setFeatures(binaryen.Features.All);

  binaryen.clearPassArguments();
  binaryen.setPassArgument('asyncify-in-secondary-memory', '1');
  binaryen.setPassArgument(
    'asyncify-secondary-memory-size',
    String(opts?.secondaryMemoryPages ?? 1),
  );
  if (opts?.asyncImports) {
    binaryen.setPassArgument(
      'asyncify-imports',
      opts.asyncImports.join(','),
    );
  }
  // When asyncImports is not specified, all imports are assumed to potentially suspend.
  // This produces larger output but ensures correct instrumentation.

  mod.runPasses(['asyncify']);

  let wat = mod.emitText();
  mod.dispose();

  wat = wat.replace(
    '(export "memory" (memory $0))',
    '(export "memory" (memory $0))\n  (export "asyncify_memory" (memory $asyncify_memory))',
  );

  const mod2 = binaryen.parseText(wat);
  mod2.setFeatures(binaryen.Features.All);
  const output = mod2.emitBinary();
  mod2.dispose();

  return output;
}

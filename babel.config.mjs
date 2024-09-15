/** @type {import('@babel/core').ConfigFunction} */
export default function config(api) {
  const isTest = api.env('test');
  const isBundler = api.caller((caller) => caller?.name === 'babel-loader');

  /** @type {import('@babel/core').TransformOptions} */
  const config = {
    assumptions: {
      noDocumentAll: true,
      noNewArrows: true,
      objectRestNoSymbols: true,
      privateFieldsAsSymbols: true,
      setSpreadProperties: true,
    },
    babelrcRoots: [
      './',
      'packages/**/',
    ],
    comments: isTest,
    ignore: [
      'node_modules'
    ],
    minified: !isTest,
    plugins: [
      '@babel/plugin-proposal-explicit-resource-management'
    ],
    presets: [
      [
        '@babel/preset-env',
        {
          modules: false,
          targets: {
            node: 'current'
          }
        }
      ],
      [
        '@babel/preset-typescript',
        {
          allowDeclareFields: true,
          rewriteImportExtensions: !isBundler && !isTest
        }
      ],
    ],
    sourceMaps: 'inline'
  };

  if (!isTest) {
    config.ignore.push('**/test/**', '**/*.test.js', '**/*.test.ts');
  }

  return config;
};

/** @type {import('@babel/core').ConfigFunction} */
module.exports = api => {
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
      ['@babel/preset-typescript', { rewriteImportExtensions: !isBundler }],
    ],
    sourceMaps: 'inline'
  };

  if (!isTest) {
    config.ignore.push('**/__tests__/**');
  }

  return config;
};

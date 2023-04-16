/** @type {import('@babel/core').ConfigFunction} */
module.exports = api => {
  const isTest = api.env('test');

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
      '.',
      'packages/*',
    ],
    comments: false,
    ignore: [
      'node_modules'
    ],
    minified: true,
    plugins: [],
    presets: [
      [
        '@babel/preset-env',
        {
          modules: false,
          targets: {
            node: true
          }
        }
      ],
      ['@babel/preset-typescript']
    ],
    sourceMaps: 'inline'
  };

  if (!isTest) {
    config.ignore.push('**/__tests__/**');
  }

  return config;
};

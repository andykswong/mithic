import * as path from 'node:path';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const PRODUCTION = 'production';

const mode = globalThis.process?.env?.NODE_ENV || PRODUCTION;
const isProd = mode === PRODUCTION;

const OUTPUT_DIR = path.resolve('./dist');

/** @type {import('webpack').Configuration} */
export default {
  mode,
  entry: {
    index: {
      import: './src/index.js'
    }
  },
  output: {
    filename: '[name].min.js',
    path: OUTPUT_DIR,
  },
  module: {
    rules: [
    ],
  },
  resolve: {
    extensions: [ '.js', '.mjs' ],
    alias: {
    },
  },
  optimization: {
    minimize: isProd,
  },
  plugins: [
    new HtmlWebpackPlugin({ title: 'mithic example' }),
    new webpack.EnvironmentPlugin({
      'NODE_ENV': mode,
    }),
  ],
  experiments: {
    asyncWebAssembly: true,
    topLevelAwait: true,
  },
  devtool: isProd ? false : 'source-map',
  devServer: {
    server: 'https',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    static: OUTPUT_DIR
  }
};

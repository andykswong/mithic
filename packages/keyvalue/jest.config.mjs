import config from '../../jest.config.mjs';
/** @type {import('jest').Config} */
export default {
  ...config,
  collectCoverageFrom: [
    ...config.collectCoverageFrom,
    'dist/**/*.js',
  ],
  coverageProvider: 'v8',
  workerThreads: true,
};

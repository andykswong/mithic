/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.spec.js'
  ],
  setupFiles: ['core-js'],
  transform: {
    '^.+\\.js?$': [
      'babel-jest',
      {
        'rootMode': 'upward'
      }
    ]
  },
  workerThreads: true,
};

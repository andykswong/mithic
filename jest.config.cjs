/** @type {import('jest').Config} */
module.exports = {
  collectCoverage: true,
  collectCoverageFrom: [
    '**/src/**/*.ts',
    '!**/__tests__/**',
    '!**/src/gen/*.ts'
  ],
  coverageDirectory: 'coverage',
  extensionsToTreatAsEsm: [
    '.ts'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.spec.ts'
  ],
  setupFiles: ['core-js'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'babel-jest',
      {
        'rootMode': 'upward'
      }
    ]
  }
};

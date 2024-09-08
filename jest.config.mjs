/** @type {import('jest').Config} */
export default {
  collectCoverage: true,
  collectCoverageFrom: [
    '**/src/**/*.ts',
    '!**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  extensionsToTreatAsEsm: [
    '.ts'
  ],
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.spec.ts'
  ],
  setupFiles: ['core-js'],
  transform: {
    '^.+\\.[jt]s?$': [
      'babel-jest',
      {
        'rootMode': 'upward'
      }
    ]
  }
};

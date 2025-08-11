export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: [
    '**/test/**/*.test.js',
    '**/__tests__/**/*.js'
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/test-*.js',
    '!src/index.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html']
};
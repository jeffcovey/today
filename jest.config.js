import { existsSync, readFileSync } from 'fs';

// Read local mount targets to exclude from Jest
const localMountsPath = '.local-mounts.json';
const localMounts = existsSync(localMountsPath)
  ? JSON.parse(readFileSync(localMountsPath, 'utf8')).targets || []
  : [];

export default {
  testEnvironment: 'node',
  transform: {},
  modulePathIgnorePatterns: [...localMounts.map(t => `<rootDir>/${t}/`), '<rootDir>/.worktrees/'],
  testPathIgnorePatterns: ['/node_modules/', '/.worktrees/'],
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
    '!src/index.js',
    '!src/**/*.old.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 60,
      statements: 60
    }
  },
  testTimeout: 10000
};
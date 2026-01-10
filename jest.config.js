import { existsSync, readFileSync } from 'fs';

// Read local mount targets from mounts.local to exclude from Jest
const mountsLocalPath = '.devcontainer/mounts.local';
const localMounts = existsSync(mountsLocalPath)
  ? readFileSync(mountsLocalPath, 'utf8')
      .split('\n')
      .filter(line => line.trim() && !line.startsWith('#') && line.includes('='))
      .map(line => line.split('=')[0].trim())
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
# Testing Strategy and Guidelines

## ⚠️ CRITICAL: NEVER TOUCH PRODUCTION DATA

**WARNING**: Tests MUST NEVER modify production data. Always use:
- `:memory:` databases for SQLite tests
- Proper mocking for external services
- Isolated test environments
- The `.data/` directory contains live production data and should NEVER be modified during testing

## Overview

This document outlines the testing strategy for the Today application, including test structure, coverage goals, and best practices.

## Test Framework

We use **Jest** with ESM support for all testing needs. The configuration is in `jest.config.js`.

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/date-parser.test.js

# Run tests in watch mode (during development)
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Git Hooks and Automation

Our pre-commit hook (`/.husky/pre-commit`) automatically:
- Runs tests **only** when source files (`src/*.js`) are modified
- Skips tests during routine note syncing or markdown edits
- Uses `--findRelatedTests` to run only relevant tests
- Fails the commit if tests don't pass

This ensures code quality without slowing down daily note-taking workflows.

## Test Structure

```
test/
├── unit/               # Pure unit tests (no external dependencies)
│   ├── date-parser.test.js
│   ├── sqlite-cache.test.js
│   └── ...
├── integration/        # Tests with dependencies
│   ├── task-manager.test.js
│   ├── turso-sync.test.js
│   └── ...
├── fixtures/          # Test data and mocks
│   ├── markdown/
│   └── database/
└── helpers/           # Test utilities
    └── setup.js
```

## Priority Testing Areas

### Priority 1 - Core Business Logic (80% coverage target)
- **DateParser** (`src/date-parser.js`) - Natural language date parsing ✅
- **TaskManager** (`src/task-manager.js`) - Task CRUD and markdown sync ✅
- **DatabaseSync** (`src/database-sync.js`) - Turso synchronization
- **SqliteCache** (`src/sqlite-cache.js`) - Caching layer

### Priority 2 - Data Integrity (70% coverage target)
- **TursoSyncOptimized** (`src/turso-sync-optimized.js`) - Incremental sync
- **SyncScheduler** (`src/sync-scheduler.js`) - Sync coordination
- **EmailManager** (`src/email-manager.js`) - Email parsing

### Priority 3 - User Features (60% coverage target)
- **TaskStageClassifier** (`src/task-stage-classifier.js`) - AI classification
- **TemporalManager** (`src/temporal-manager.js`) - Time-based tasks
- CLI commands (`bin/` directory)

## Coverage Goals

| Area | Current | Target | Notes |
|------|---------|--------|-------|
| Overall | TBD | 60% | Initial goal |
| Core Business Logic | TBD | 80% | Critical paths |
| Data Layer | TBD | 70% | Sync and storage |
| User Features | TBD | 60% | CLI and UI |

## Writing Tests

### Test File Naming
- Unit tests: `[module].test.js`
- Integration tests: `[feature].integration.test.js`
- End-to-end tests: `[workflow].e2e.test.js`

### Test Structure Example

```javascript
import { jest } from '@jest/globals';
import { ModuleName } from '../src/module-name.js';

describe('ModuleName', () => {
  let instance;
  
  beforeEach(() => {
    // Setup
    instance = new ModuleName();
  });
  
  afterEach(() => {
    // Cleanup
    jest.clearAllMocks();
  });
  
  describe('methodName', () => {
    test('should handle normal case', () => {
      // Arrange
      const input = 'test';
      
      // Act
      const result = instance.methodName(input);
      
      // Assert
      expect(result).toBe('expected');
    });
    
    test('should handle edge case', () => {
      // Test edge cases
    });
    
    test('should handle error case', () => {
      // Test error handling
    });
  });
});
```

### Best Practices

1. **Test Isolation**: Each test should be independent
2. **Clear Names**: Test names should describe what is being tested
3. **AAA Pattern**: Arrange, Act, Assert
4. **Mock External Dependencies**: Use Jest mocks for external services
5. **Test Data**: Use fixtures for complex test data
6. **Performance**: Use in-memory SQLite for database tests

## Mocking Guidelines

### Database Mocking
```javascript
jest.mock('../src/database-sync.js', () => ({
  getDatabaseSync: jest.fn(() => {
    const Database = jest.requireActual('better-sqlite3');
    return new Database(':memory:');
  })
}));
```

### File System Mocking
```javascript
import { jest } from '@jest/globals';
import fs from 'fs/promises';

jest.mock('fs/promises');

beforeEach(() => {
  fs.readFile.mockResolvedValue('file content');
  fs.writeFile.mockResolvedValue();
});
```

## Continuous Integration

### GitHub Actions (Future)
```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
      - run: npm run test:coverage
```

## Regression Testing

When fixing bugs:
1. Write a failing test that reproduces the bug
2. Fix the bug
3. Ensure the test passes
4. Add the test to prevent regression

## Performance Testing

For critical paths like sync operations:
```javascript
test('should sync 1000 tasks in under 2 seconds', async () => {
  const startTime = Date.now();
  
  // Create 1000 tasks
  for (let i = 0; i < 1000; i++) {
    taskManager.createTask({ title: `Task ${i}` });
  }
  
  // Sync
  await taskManager.syncToDatabase();
  
  const duration = Date.now() - startTime;
  expect(duration).toBeLessThan(2000);
});
```

## Weekly Coverage Review

A recurring task is set up to review and improve test coverage weekly. During this review:

1. Run `npm run test:coverage`
2. Identify uncovered critical paths
3. Write tests for at least one uncovered module
4. Update coverage goals if needed
5. Document any testing challenges

## Common Test Scenarios

### Date Parsing Tests
- Quick tags (@today, @tomorrow, @weekend)
- Relative dates (@3d, @2w, @1m)
- Natural language (@next tuesday, @in 3 days)
- Absolute dates (@aug 25, @8/25/2025)
- Edge cases (invalid dates, past dates)

### Task Management Tests
- CRUD operations
- Markdown synchronization
- Date tag extraction
- Duplicate prevention
- Project association

### Sync Tests
- Incremental sync
- Conflict resolution
- Network failures
- Data consistency

## Troubleshooting

### Common Issues

1. **Tests timing out**: Increase timeout in `jest.config.js`
2. **Module not found**: Check import paths and moduleNameMapper
3. **Async issues**: Ensure proper use of async/await
4. **Database locks**: Use separate test databases

### Debug Mode
```bash
# Run tests with debugging
node --inspect-brk node_modules/.bin/jest --runInBand

# Verbose output
npm test -- --verbose

# Run single test
npm test -- -t "should parse @today correctly"
```

## Future Improvements

- [x] Set up GitHub Actions for CI/CD <!-- task-id: af645ecc1dfe3f1a4a1367985ee0f5af -->
- [x] Add visual regression testing for UI components <!-- task-id: 2eb382043ea9051ea9ee2ea0738165fd -->
- [x] Implement load testing for sync operations <!-- task-id: 136f7f86ca84face071a4e82331c9ff7 -->
- [x] Add mutation testing to verify test quality <!-- task-id: b6ef433dc67e86270d152fcdfa61d50d -->
- [x] Create test data generators <!-- task-id: ddb81f7995ac04ccb58b4db0ee3ffdd6 -->
- [x] Set up test database seeding <!-- task-id: 80b65cd38d3823df2dba561c6f0a99dd -->

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [Jest ESM Support](https://jestjs.io/docs/ecmascript-modules)
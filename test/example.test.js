import { jest } from '@jest/globals';

describe('Example Test Suite', () => {
  test('should run a simple test', () => {
    expect(1 + 1).toBe(2);
  });

  test('should work with async tests', async () => {
    const promise = Promise.resolve('hello');
    await expect(promise).resolves.toBe('hello');
  });

  test('should work with mocks', () => {
    const mockFn = jest.fn();
    mockFn('test');
    expect(mockFn).toHaveBeenCalledWith('test');
  });
});
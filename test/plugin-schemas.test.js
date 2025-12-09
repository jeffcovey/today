import { validateEntries, getSchema, getPluginTypes } from '../src/plugin-schemas.js';

describe('Plugin Schemas', () => {
  describe('getSchema', () => {
    test('should return schema for time-entries', () => {
      const schema = getSchema('time-entries');

      expect(schema).not.toBeNull();
      expect(schema.required).toContain('start_time');
      expect(schema.required).toContain('description');
      expect(schema.optional).toContain('end_time');
    });

    test('should return null for unknown type', () => {
      const schema = getSchema('unknown-type');

      expect(schema).toBeNull();
    });
  });

  describe('getPluginTypes', () => {
    test('should return array of plugin types', () => {
      const types = getPluginTypes();

      expect(Array.isArray(types)).toBe(true);
      expect(types).toContain('time-entries');
    });
  });

  describe('validateEntries', () => {
    const mockLogger = {
      error: () => {},
      warn: () => {}
    };

    describe('time-entries', () => {
      test('should pass valid entries', () => {
        const entries = [
          {
            start_time: '2025-01-15T09:00:00-05:00',
            end_time: '2025-01-15T10:30:00-05:00',
            duration_minutes: 90,
            description: 'Working on tests',
            topics: '#topic/programming'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      test('should pass entries with only required fields', () => {
        const entries = [
          {
            start_time: '2025-01-15T09:00:00-05:00',
            description: 'Working on tests'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      test('should fail when missing required field start_time', () => {
        const entries = [
          {
            description: 'Missing start time'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('start_time');
      });

      test('should fail when missing required field description', () => {
        const entries = [
          {
            start_time: '2025-01-15T09:00:00-05:00'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('description');
      });

      test('should fail when required field has wrong type', () => {
        const entries = [
          {
            start_time: 12345,  // should be string
            description: 'Test'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('should be string');
      });

      test('should warn about unknown fields', () => {
        const entries = [
          {
            start_time: '2025-01-15T09:00:00-05:00',
            description: 'Test',
            unknown_field: 'value'
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(true);  // warnings don't fail
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('unknown_field');
      });

      test('should warn about wrong type on optional field', () => {
        const entries = [
          {
            start_time: '2025-01-15T09:00:00-05:00',
            description: 'Test',
            duration_minutes: '90'  // should be number
          }
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(true);  // warnings don't fail
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('duration_minutes');
      });
    });

    describe('unknown type', () => {
      test('should warn but pass for unknown plugin type', () => {
        const entries = [{ anything: 'goes' }];

        const result = validateEntries('unknown-type', entries, { logger: mockLogger });

        expect(result.valid).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('No schema defined');
      });
    });

    describe('multiple entries', () => {
      test('should validate all entries and collect errors', () => {
        const entries = [
          { start_time: '2025-01-15T09:00:00-05:00', description: 'Valid' },
          { description: 'Missing start_time' },
          { start_time: '2025-01-15T10:00:00-05:00' }  // missing description
        ];

        const result = validateEntries('time-entries', entries, { logger: mockLogger });

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(2);
      });
    });
  });
});

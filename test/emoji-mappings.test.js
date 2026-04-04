import {
  emojiToFontAwesome,
  convertEmojisToIcons,
} from '../src/emoji-mappings.js';

describe('emoji-mappings', () => {
  describe('emojiToFontAwesome map', () => {
    test('contains entries for common status emojis', () => {
      expect(emojiToFontAwesome['✅']).toContain('fa-check-circle');
      expect(emojiToFontAwesome['❌']).toContain('fa-times-circle');
      expect(emojiToFontAwesome['⚠️']).toContain('fa-exclamation-triangle');
    });

    test('entries contain Font Awesome icon HTML', () => {
      const entry = emojiToFontAwesome['✅'];
      expect(entry).toContain('<i class="fas fa-');
      expect(entry).toContain('</i>');
    });

    test('contains entries for a variety of emoji categories', () => {
      // Documents
      expect(emojiToFontAwesome['📝']).toBeTruthy();
      // Calendar
      expect(emojiToFontAwesome['📅']).toBeTruthy();
      // Home
      expect(emojiToFontAwesome['🏠']).toBeTruthy();
    });

    test('is an object with string keys and string values', () => {
      for (const [key, value] of Object.entries(emojiToFontAwesome)) {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
      }
    });
  });

  describe('convertEmojisToIcons', () => {
    test('replaces a single emoji with its Font Awesome equivalent', () => {
      const result = convertEmojisToIcons('Task done ✅');
      expect(result).toContain('fa-check-circle');
      expect(result).not.toContain('✅');
    });

    test('replaces multiple emojis in the same string', () => {
      const result = convertEmojisToIcons('✅ Complete ❌ Failed');
      expect(result).toContain('fa-check-circle');
      expect(result).toContain('fa-times-circle');
      expect(result).not.toContain('✅');
      expect(result).not.toContain('❌');
    });

    test('preserves non-emoji text', () => {
      const result = convertEmojisToIcons('<p>Hello world</p>');
      expect(result).toBe('<p>Hello world</p>');
    });

    test('handles empty string', () => {
      expect(convertEmojisToIcons('')).toBe('');
    });

    test('leaves unknown emojis unchanged', () => {
      // 🦄 is unlikely to be in the mapping
      const result = convertEmojisToIcons('🦄 unicorn');
      expect(result).toContain('🦄');
    });

    test('replaces emojis within HTML content', () => {
      const html = '<p>Status: ✅ Done</p>';
      const result = convertEmojisToIcons(html);
      expect(result).toContain('<i class="fas fa-check-circle');
      expect(result).toContain('<p>Status: ');
    });

    test('handles longer multi-character emojis before shorter ones', () => {
      // Ensure the function handles emoji sequences correctly
      const result = convertEmojisToIcons('⚠️ warning');
      expect(result).not.toContain('⚠️');
      expect(result).toContain('fas fa-');
    });
  });
});

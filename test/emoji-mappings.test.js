import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  emojiToFontAwesome,
  convertEmojisToIcons,
} from '../src/emoji-mappings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

    test('converts link text without changing emoji-bearing attributes', () => {
      const result = convertEmojisToIcons('<a href="notes/📔.md">📔 note</a>');
      expect(result).toBe(`<a href="notes/📔.md">${emojiToFontAwesome['📔']} note</a>`);
    });

    test('leaves emojis in title and aria-label attributes untouched', () => {
      const html = '<span title="📔 title" aria-label="✅ label">✅ text</span>';
      const result = convertEmojisToIcons(html);
      expect(result).toBe(`<span title="📔 title" aria-label="✅ label">${emojiToFontAwesome['✅']} text</span>`);
    });

    test('leaves emojis inside code and pre elements untouched', () => {
      const html = '<code>✅</code><pre><code>🔺</code></pre> ✅';
      const result = convertEmojisToIcons(html);
      expect(result).toBe(`<code>✅</code><pre><code>🔺</code></pre> ${emojiToFontAwesome['✅']}`);
    });

    test('handles nested and case-insensitive protected elements', () => {
      const html = '<CODE><code>✅</code>🔺</CODE><SCRIPT>📔</SCRIPT><STYLE>🔼</STYLE><TEXTAREA>✅</TEXTAREA> ✅';
      const result = convertEmojisToIcons(html);
      expect(result).toBe(`<CODE><code>✅</code>🔺</CODE><SCRIPT>📔</SCRIPT><STYLE>🔼</STYLE><TEXTAREA>✅</TEXTAREA> ${emojiToFontAwesome['✅']}`);
    });

    test('handles longer multi-character emojis before shorter ones', () => {
      // Ensure the function handles emoji sequences correctly
      const result = convertEmojisToIcons('⚠️ warning');
      expect(result).not.toContain('⚠️');
      expect(result).toContain('fas fa-');
    });
  });
});

describe('emoji-mappings against Font Awesome 6.4 Free', () => {
  // The icon names in Font Awesome Free 6.4.0's all.min.css, which the web view
  // loads; an icon missing from it renders as blank space.
  const freeIcons = new Set(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'fontawesome-free-6.4.0-icons.txt'), 'utf8')
      .split('\n').filter(Boolean)
  );
  const iconName = html => html.match(/fa-[a-z0-9-]+/g).find(c => c !== 'fa-solid');

  test('every mapped icon exists in Font Awesome Free', () => {
    const missing = Object.entries(emojiToFontAwesome)
      .filter(([, html]) => !freeIcons.has(iconName(html)))
      .map(([emoji, html]) => `${emoji} ${iconName(html)}`);
    expect(missing).toEqual([]);
  });

  const taskMarkers = ['🔺', '⏫', '🔼', '🔽', '⏬', '⏳', '🛫', '➕', '🔁', '📅', '✅', '❌'];

  test('every Obsidian Tasks marker maps to an icon', () => {
    expect(taskMarkers.filter(e => !emojiToFontAwesome[e])).toEqual([]);
  });

  test('the five priorities have five distinct, labelled icons', () => {
    const priorities = ['🔺', '⏫', '🔼', '🔽', '⏬'];
    const icons = priorities.map(e => iconName(emojiToFontAwesome[e]));
    expect(new Set(icons).size).toBe(5);
    for (const e of priorities) {
      expect(emojiToFontAwesome[e]).toMatch(/role="img" aria-label="[A-Z][a-z]+ priority"/);
    }
  });

  test('unlabelled icons are hidden from screen readers', () => {
    expect(emojiToFontAwesome['🏠']).toContain('aria-hidden="true"');
  });
});

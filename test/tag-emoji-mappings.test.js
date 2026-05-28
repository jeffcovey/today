import {
  tagToEmoji,
  replaceTagsWithEmojis,
  getTopicEmoji,
} from '../src/tag-emoji-mappings.js';

describe('tag-emoji-mappings', () => {
  describe('tagToEmoji map', () => {
    test('contains stage mappings', () => {
      expect(tagToEmoji['stage/front-stage']).toBe('🎭');
      expect(tagToEmoji['stage/back-stage']).toBe('🔧');
      expect(tagToEmoji['stage/off-stage']).toBe('🕰️');
      expect(tagToEmoji['stage/filed']).toBe('📂');
    });

    test('contains topic mappings', () => {
      expect(tagToEmoji['topic/development']).toBe('💻');
      expect(tagToEmoji['topic/finance']).toBe('💰');
      expect(tagToEmoji['topic/health']).toBe('🏥');
      expect(tagToEmoji['topic/work']).toBe('💼');
    });
  });

  describe('replaceTagsWithEmojis', () => {
    test('replaces a known stage tag', () => {
      const result = replaceTagsWithEmojis('Task #stage/front-stage important');
      expect(result).toBe('Task 🎭 important');
    });

    test('replaces a known topic tag', () => {
      const result = replaceTagsWithEmojis('Working on #topic/development today');
      expect(result).toBe('Working on 💻 today');
    });

    test('replaces multiple tags in one string', () => {
      const result = replaceTagsWithEmojis('#stage/filed and #topic/finance stuff');
      expect(result).toContain('📂');
      expect(result).toContain('💰');
    });

    test('removes unknown stage and topic tags', () => {
      const result = replaceTagsWithEmojis('Some #stage/unknown-stage task');
      expect(result).not.toContain('#stage/');
    });

    test('removes unknown topic tags', () => {
      const result = replaceTagsWithEmojis('Some #topic/nonexistent task');
      expect(result).not.toContain('#topic/');
    });

    test('does not modify text without tags', () => {
      const text = 'This is plain text with no tags';
      expect(replaceTagsWithEmojis(text)).toBe(text);
    });

    test('does not replace non-stage/topic hashtags', () => {
      const text = 'Check #important for details';
      expect(replaceTagsWithEmojis(text)).toBe(text);
    });
  });

  describe('getTopicEmoji', () => {
    test('returns emoji for an exact topic name', () => {
      expect(getTopicEmoji('development')).toBe('💻');
      expect(getTopicEmoji('finance')).toBe('💰');
      expect(getTopicEmoji('work')).toBe('💼');
    });

    test('normalizes spaces to underscores', () => {
      expect(getTopicEmoji('home household')).toBe('🏠');
    });

    test('normalizes mixed case', () => {
      expect(getTopicEmoji('Development')).toBe('💻');
      expect(getTopicEmoji('FINANCE')).toBe('💰');
    });

    test('normalizes dashes to underscores and vice versa', () => {
      // 'friends_socializing' uses underscores in the map
      expect(getTopicEmoji('friends-socializing')).toBe('👥');
      // 'mental_health' uses underscores
      expect(getTopicEmoji('mental-health')).toBe('🧠');
    });

    test('returns empty string for unknown topic', () => {
      expect(getTopicEmoji('completely-unknown-topic-xyz')).toBe('');
    });
  });
});

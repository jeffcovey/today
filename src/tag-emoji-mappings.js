// Single source of truth for tag to emoji mappings
// Used by task-manager.js

const tagToEmoji = {
  // Stages
  'stage/front-stage': '🎭',
  'stage/back-stage': '🔧',
  'stage/off-stage': '🕰️',
  'stage/filed': '📂',

  // Topics - alphabetical order
  'topic/admin': '📋',
  'topic/business': '💼',
  'topic/cats': '🐱',
  'topic/cleaning': '🧹',
  'topic/communication': '💬',
  'topic/development': '💻',
  'topic/email': '📧',
  'topic/entertainment': '🎬',
  'topic/family': '👨‍👩‍👧‍👦',
  'topic/finance': '💰',
  'topic/fitness': '💪',
  'topic/focus': '🎯',
  'topic/friends_socializing': '👥',
  'topic/health': '🏥',
  'topic/hobbies': '🎨',
  'topic/home': '🏠',
  'topic/home_household': '🏠',
  'topic/household': '🏠',
  'topic/local_exploration_adventure': '🗺️',
  'topic/maintenance': '🔧',
  'topic/marketing': '📢',
  'topic/meditation_mindfulness': '🧘',
  'topic/mental_health': '🧠',
  'topic/mindset': '🧠',
  'topic/money': '💵',
  'topic/ogm_events': '🏳️‍🌈',
  'topic/organization': '🗂️',
  'topic/personal': '👤',
  'topic/personal_admin': '📋',
  'topic/pets': '🐾',
  'topic/planning': '📅',
  'topic/productivity': '⚡',
  'topic/programming': '💻',
  'topic/projects': '📁',
  'topic/relationships': '❤️',
  'topic/shopping': '🛒',
  'topic/social': '👥',
  'topic/technology': '🖥️',
  'topic/travel': '✈️',
  'topic/work': '💼',
  'topic/yard': '🌳',

  // Additional topic variations that may appear
  'topic/exercise': '🏃',
  'topic/medical': '⚕️',
  'topic/wellness': '🧘',
  'topic/kids': '👶',
  'topic/repairs': '🔨',
  'topic/pool': '🏊',
  'topic/landscaping': '🌿',
  'topic/garden': '🌱',
  'topic/lawn': '🌾',
  'topic/budget': '📊',
  'topic/investment': '📈',
};

// Function to replace tags with emojis in text
function replaceTagsWithEmojis(text) {
  let result = text;

  // Replace each tag with its emoji
  for (const [tag, emoji] of Object.entries(tagToEmoji)) {
    const regex = new RegExp(`#${tag}\\b`, 'g');
    result = result.replace(regex, emoji);
  }

  // Remove any remaining #stage/ or #topic/ tags that don't have mappings
  result = result.replace(/#(stage|topic)\/[\w-]+/g, '');

  return result;
}

// Function to get emoji for a topic name (without the #topic/ prefix)
// This is for backward compatibility with task-manager.js
function getTopicEmoji(topicName) {
  // Convert various formats to our standard format
  const normalized = topicName
    .toLowerCase()
    .replace(/[\s/]+/g, '_')  // Replace spaces and slashes with underscore
    .replace(/[^\w_-]/g, ''); // Remove any other special characters

  // Try with topic/ prefix
  const withPrefix = `topic/${normalized}`;
  if (tagToEmoji[withPrefix]) {
    return tagToEmoji[withPrefix];
  }

  // Try alternative variations
  const variations = [
    normalized,
    normalized.replace(/_/g, '-'),
    normalized.replace(/-/g, '_'),
  ];

  for (const variant of variations) {
    const key = `topic/${variant}`;
    if (tagToEmoji[key]) {
      return tagToEmoji[key];
    }
  }

  // No mapping found
  return '';
}

export {
  tagToEmoji,
  replaceTagsWithEmojis,
  getTopicEmoji
};
// Converts Pestle export recipes (schema.org Recipe JSON with Pestle's own
// extras) into recipe markdown files with schema.org-named frontmatter.

import * as yaml from 'js-yaml';

// Pestle stores dates as seconds since 2001-01-01 (Apple's reference date).
const APPLE_EPOCH_SECONDS = 978307200;

const NUTRITION_KEYS = [
  'servingSize', 'calories', 'fatContent', 'saturatedFatContent', 'cholesterolContent',
  'sodiumContent', 'carbohydrateContent', 'fiberContent', 'sugarContent', 'proteinContent'
];

const VIDEO_KEYS = ['name', 'duration', 'contentUrl', 'embedUrl', 'thumbnailUrl'];

function present(value) {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function pick(object, keys) {
  if (!object) return null;
  const out = {};
  for (const key of keys) if (present(object[key])) out[key] = object[key];
  return Object.keys(out).length ? out : null;
}

function oneLine(text) {
  return String(text).replace(/\s*\n\s*/g, ' ').trim();
}

function appleDate(seconds) {
  if (typeof seconds !== 'number') return null;
  return new Date((APPLE_EPOCH_SECONDS + seconds) * 1000).toISOString().slice(0, 10);
}

function yieldText(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value);
}

export function fileNameFor(name) {
  const base = String(name || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
  return `${base || 'Untitled'}.md`;
}

function instructionLines(steps) {
  const lines = [];
  let number = 0;
  for (const step of steps || []) {
    if (typeof step === 'string') {
      lines.push(`${++number}. ${oneLine(step)}`);
    } else if (step.itemListElement?.length) {
      if (lines.length) lines.push('');
      lines.push(`### ${oneLine(step.name || 'Steps')}`, '');
      number = 0;
      for (const inner of step.itemListElement) {
        const text = typeof inner === 'string' ? inner : inner.text;
        if (text) lines.push(`${++number}. ${oneLine(text)}`);
      }
      lines.push('');
    } else if (step.text) {
      lines.push(`${++number}. ${oneLine(step.text)}`);
    }
  }
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

export function pestleToMarkdown(recipe) {
  const images = (Array.isArray(recipe.image) ? recipe.image : [recipe.image])
    .map(image => (typeof image === 'string' ? image : image?.url))
    .filter(Boolean);
  const author = typeof recipe.author === 'string' ? recipe.author : recipe.author?.name;
  const rating = recipe.aggregateRating?.ratingValue != null
    ? pick(recipe.aggregateRating, ['ratingValue', 'ratingCount'])
    : null;

  const frontmatter = {
    name: recipe.name,
    url: recipe.source,
    image: images.length > 1 ? images : images[0],
    author,
    datePublished: recipe.datePublished,
    dateAdded: appleDate(recipe.dateAdded),
    identifier: recipe.id,
    recipeCategory: recipe.recipeCategory,
    recipeCuisine: recipe.recipeCuisine,
    keywords: recipe.keywords,
    recipeYield: yieldText(recipe.recipeYield),
    prepTime: recipe.prepTime,
    cookTime: recipe.cookTime,
    totalTime: recipe.totalTime,
    nutrition: pick(recipe.nutrition, NUTRITION_KEYS),
    aggregateRating: rating,
    video: pick(recipe.video, VIDEO_KEYS)
  };
  for (const key of Object.keys(frontmatter)) {
    if (!present(frontmatter[key])) delete frontmatter[key];
  }

  const body = [`# ${oneLine(recipe.name || 'Untitled')}`, ''];
  if (images[0]) body.push(`![${oneLine(recipe.name || '')}](${images[0]})`, '');
  if (present(recipe.description)) body.push(String(recipe.description).trim(), '');

  body.push('## Ingredients', '');
  for (const ingredient of recipe.recipeIngredient || []) {
    const text = typeof ingredient === 'string' ? ingredient : ingredient.text || ingredient.name;
    if (text) body.push(`- ${oneLine(text)}`);
  }
  body.push('', '## Instructions', '', ...instructionLines(recipe.recipeInstructions), '');

  if (present(recipe.note)) body.push('## Notes', '', String(recipe.note).trim(), '');

  const header = yaml.dump(frontmatter, { lineWidth: -1, schema: yaml.JSON_SCHEMA }).trimEnd();
  return `---\n${header}\n---\n\n${body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

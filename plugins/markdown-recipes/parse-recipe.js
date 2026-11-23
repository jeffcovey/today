// Parses a recipe markdown file: schema.org Recipe properties in YAML
// frontmatter, then a body with `# Name`, a description, and `## Ingredients`,
// `## Instructions` (optionally split by `###` sections) and `## Notes`.

import * as yaml from 'js-yaml';

export function parseDuration(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value);
  const iso = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const seconds = (+iso[1] || 0) * 86400 + (+iso[2] || 0) * 3600 + (+iso[3] || 0) * 60 + (+iso[4] || 0);
    return Math.round(seconds / 60);
  }
  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  if (!hours && !minutes) return null;
  return (hours ? +hours[1] * 60 : 0) + (minutes ? +minutes[1] : 0);
}

function toList(value) {
  if (value == null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map(item => String(item).trim()).filter(Boolean);
}

function leadingNumber(value) {
  const match = value == null ? null : String(value).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function splitFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { data: {}, body: content, error: null };
  try {
    const data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
    return { data: data && typeof data === 'object' ? data : {}, body: content.slice(match[0].length), error: null };
  } catch (error) {
    return { data: {}, body: content.slice(match[0].length), error: error.message };
  }
}

function stripMarker(line) {
  return line.replace(/^(?:[*+-]|\d+[.)])\s+/, '');
}

export function parseRecipe(content, fallbackTitle) {
  const { data, body, error } = splitFrontmatter(content.replace(/\r\n/g, '\n'));

  let heading = null;
  const intro = [];
  const sections = {};
  let current = null;
  let subsection = null;

  for (const line of body.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h && h[1] === '#' && heading === null && current === null) {
      heading = h[2];
    } else if (h && h[1] === '##') {
      current = h[2].trim().toLowerCase();
      sections[current] = [];
      subsection = null;
    } else if (h && current) {
      subsection = h[2];
    } else if (current) {
      const text = line.trim();
      if (text) sections[current].push(subsection && current === 'instructions' ? `${subsection}: ${stripMarker(text)}` : text);
    } else {
      intro.push(line);
    }
  }

  const description = intro
    .filter(line => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    .join('\n').trim();

  const images = toList(data.image);
  const nutrition = data.nutrition && typeof data.nutrition === 'object' ? data.nutrition : {};
  const author = typeof data.author === 'object' ? data.author?.name : data.author;

  return {
    title: String(data.name || heading || fallbackTitle),
    description: description || (data.description ? String(data.description) : null),
    categories: toList(data.recipeCategory),
    cuisines: toList(data.recipeCuisine),
    keywords: toList(data.keywords),
    prep_time_minutes: parseDuration(data.prepTime),
    cook_time_minutes: parseDuration(data.cookTime),
    total_time_minutes: parseDuration(data.totalTime),
    servings: data.recipeYield != null ? String(data.recipeYield) : null,
    url: data.url ? String(data.url) : null,
    author: author ? String(author) : null,
    image_url: images[0] || null,
    rating: leadingNumber(data.aggregateRating?.ratingValue),
    ingredients: (sections.ingredients || []).map(stripMarker),
    instructions: (sections.instructions || []).map(stripMarker),
    nutrition,
    calories: leadingNumber(nutrition.calories),
    protein_grams: leadingNumber(nutrition.proteinContent),
    notes: (sections.notes || []).join('\n') || null,
    date_added: data.dateAdded ? String(data.dateAdded) : null,
    extra: {
      ...(data.aggregateRating?.ratingCount != null ? { rating_count: data.aggregateRating.ratingCount } : {}),
      ...(data.datePublished ? { date_published: String(data.datePublished) } : {}),
      ...(data.identifier ? { identifier: String(data.identifier) } : {}),
      ...(data.video ? { video: data.video } : {}),
      ...(error ? { frontmatter_error: error } : {})
    }
  };
}

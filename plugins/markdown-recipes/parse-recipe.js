// Parses a recipe markdown file in the layout Pestle exports:
//
//   # Title
//   Description paragraphs
//   **Category** dinner
//   **Total Time** 25m
//   ## Ingredients      (bulleted)
//   ## Instructions     (numbered)
//   ## Nutrition        (**Calories** 271 kcal ...)
//   ## Notes

const FIELD_LINE = /^\*\*([^*]+)\*\*\s*(.*)$/;

export function parseDuration(text) {
  if (!text) return null;
  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  if (!hours && !minutes) return null;
  return (hours ? parseInt(hours[1], 10) * 60 : 0) + (minutes ? parseInt(minutes[1], 10) : 0);
}

function snakeCase(label) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function splitList(value) {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function leadingNumber(value) {
  const match = value?.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function listItems(lines) {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^(?:[*+-]|\d+[.)])\s+/, ''));
}

export function parseRecipe(content, fallbackTitle) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  let title = null;
  const intro = [];
  const sections = {};
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (heading && heading[1] === '#' && title === null && current === null) {
      title = heading[2];
      continue;
    }
    if (heading && heading[1] === '##') {
      current = snakeCase(heading[2]);
      sections[current] = [];
      continue;
    }
    (current ? sections[current] : intro).push(line);
  }

  const fields = {};
  const description = [];
  for (const line of intro) {
    const field = line.trim().match(FIELD_LINE);
    if (field) {
      fields[snakeCase(field[1])] = field[2].trim();
    } else {
      description.push(line);
    }
  }

  const nutrition = {};
  for (const line of sections.nutrition || []) {
    const field = line.trim().match(FIELD_LINE);
    if (field) nutrition[snakeCase(field[1])] = field[2].trim();
  }

  const extra = {};
  for (const key of ['prep_time', 'cook_time']) {
    const minutes = parseDuration(fields[key]);
    if (minutes != null) extra[`${key}_minutes`] = minutes;
  }

  return {
    title: title || fallbackTitle,
    description: description.join('\n').trim() || null,
    categories: fields.category ? splitList(fields.category) : [],
    cuisines: fields.cuisine ? splitList(fields.cuisine) : [],
    total_time_minutes: parseDuration(fields.total_time),
    servings: fields.servings || null,
    recipe_source: fields.source || null,
    ingredients: listItems(sections.ingredients || []),
    instructions: listItems(sections.instructions || []),
    nutrition,
    calories: leadingNumber(nutrition.calories),
    protein_grams: leadingNumber(nutrition.protein),
    notes: (sections.notes || []).join('\n').trim() || null,
    extra
  };
}

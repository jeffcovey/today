import { parseRecipe, parseDuration } from '../plugins/markdown-recipes/parse-recipe.js';
import { pestleToMarkdown, fileNameFor } from '../plugins/markdown-recipes/pestle.js';

const RECIPE = `---
name: Butter Chickpeas
url: https://example.com/butter-chickpeas/
image:
  - https://example.com/a.jpg
  - https://example.com/b.jpg
author: Jane Cook
dateAdded: 2025-03-01
datePublished: 2024-02-01T10:00:00.000-05:00
recipeCategory: [dinner]
recipeCuisine: american, indian
keywords: [vegan]
recipeYield: "2"
prepTime: PT5M
cookTime: PT20M
totalTime: PT1H25M
nutrition:
  calories: 271 kcal
  proteinContent: 8 g
aggregateRating:
  ratingValue: 4.8
  ratingCount: 120
---

# Butter Chickpeas

![Butter Chickpeas](https://example.com/a.jpg)

A vegan twist on butter chicken.

## Ingredients

- 2 tbsp butter
- 1 small onion (diced)

## Instructions

### Sauce

1. Melt the butter.

### Chickpeas

1. Add the chickpeas.

## Notes

Use plain tomato sauce.
`;

describe('parseRecipe', () => {
  const recipe = parseRecipe(RECIPE, 'fallback');

  test('reads schema.org frontmatter', () => {
    expect(recipe).toMatchObject({
      title: 'Butter Chickpeas',
      url: 'https://example.com/butter-chickpeas/',
      image_url: 'https://example.com/a.jpg',
      author: 'Jane Cook',
      date_added: '2025-03-01',
      categories: ['dinner'],
      cuisines: ['american', 'indian'],
      keywords: ['vegan'],
      servings: '2',
      prep_time_minutes: 5,
      cook_time_minutes: 20,
      total_time_minutes: 85,
      rating: 4.8,
      calories: 271,
      protein_grams: 8
    });
    expect(recipe.extra).toMatchObject({ rating_count: 120, date_published: '2024-02-01T10:00:00.000-05:00' });
  });

  test('reads the body, skipping the photo line and prefixing sectioned steps', () => {
    expect(recipe.description).toBe('A vegan twist on butter chicken.');
    expect(recipe.ingredients).toEqual(['2 tbsp butter', '1 small onion (diced)']);
    expect(recipe.instructions).toEqual(['Sauce: Melt the butter.', 'Chickpeas: Add the chickpeas.']);
    expect(recipe.notes).toBe('Use plain tomato sauce.');
  });

  test('falls back to the heading, then the file name, for a recipe without frontmatter', () => {
    expect(parseRecipe('# Soup\n\nHot.\n', 'x').title).toBe('Soup');
    const bare = parseRecipe('Just some text.\n', 'Grandma Soup');
    expect(bare.title).toBe('Grandma Soup');
    expect(bare.ingredients).toEqual([]);
    expect(bare.calories).toBeNull();
  });

  test('keeps going when the frontmatter is not valid YAML', () => {
    const broken = parseRecipe('---\nname: [oops\n---\n# Pie\n', 'x');
    expect(broken.title).toBe('Pie');
    expect(broken.extra.frontmatter_error).toBeTruthy();
  });
});

describe('parseDuration', () => {
  test.each([
    ['PT25M', 25], ['PT1H', 60], ['PT8H10M', 490], ['PT3M40S', 4], ['P1D', 1440],
    ['25m', 25], ['1h 30m', 90], ['', null], ['about a while', null], [null, null]
  ])('%s → %s', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes);
  });
});

describe('pestleToMarkdown', () => {
  const pestle = {
    '@type': 'Recipe',
    id: 'ABC-123',
    name: 'Shrimp and Grits',
    source: 'https://example.com/shrimp-and-grits',
    image: [{ url: 'https://example.com/sg.jpg', width: null, height: null }],
    author: { name: 'Chef', '@type': 0 },
    datePublished: '2015-11-19T02:17:39.000-05:00',
    dateAdded: 732742254.8,
    recipeCategory: ['seafood', 'brunch'],
    recipeCuisine: [],
    keywords: [],
    recipeYield: '4.0',
    prepTime: 'PT15M',
    totalTime: 'PT45M',
    nutrition: { calories: '500 kcal', proteinContent: '30 g', servingSize: null },
    aggregateRating: { ratingValue: 5, ratingCount: 3 },
    description: 'Creamy grits.\n\nWith shrimp.',
    recipeIngredient: [{ text: '1 cup grits', name: 'grits', quantity: 1, unit: 'cup' }],
    recipeInstructions: [
      { '@type': 0, name: 'GRITS', itemListElement: [{ text: 'Boil water.' }, { text: 'Add\ngrits.' }] },
      { '@type': 0, name: 'SHRIMP', itemListElement: [{ text: 'Cook shrimp.' }] }
    ],
    note: 'Serve hot.',
    posterId: 'internal',
    postDeviceUUID: 'internal'
  };
  const markdown = pestleToMarkdown(pestle);

  test('writes schema.org frontmatter and drops Pestle internals', () => {
    expect(markdown).toMatch(/^---\nname: Shrimp and Grits\nurl: https:\/\/example.com\/shrimp-and-grits\n/);
    expect(markdown).toContain('dateAdded: 2024-03-21\n');
    expect(markdown).toContain("recipeYield: '4'\n");
    expect(markdown).not.toMatch(/posterId|postDeviceUUID|servingSize|recipeCuisine|keywords/);
  });

  test('round-trips through the parser', () => {
    const recipe = parseRecipe(markdown, 'x');
    expect(recipe).toMatchObject({
      title: 'Shrimp and Grits',
      url: 'https://example.com/shrimp-and-grits',
      image_url: 'https://example.com/sg.jpg',
      author: 'Chef',
      date_added: '2024-03-21',
      categories: ['seafood', 'brunch'],
      servings: '4',
      prep_time_minutes: 15,
      total_time_minutes: 45,
      rating: 5,
      calories: 500,
      protein_grams: 30,
      description: 'Creamy grits.\n\nWith shrimp.',
      ingredients: ['1 cup grits'],
      instructions: ['GRITS: Boil water.', 'GRITS: Add grits.', 'SHRIMP: Cook shrimp.'],
      notes: 'Serve hot.'
    });
    expect(recipe.extra.identifier).toBe('ABC-123');
  });

  test('makes safe file names', () => {
    expect(fileNameFor('Mac & Cheese: 1/2 batch?')).toBe('Mac & Cheese 12 batch.md');
    expect(fileNameFor('')).toBe('Untitled.md');
  });
});

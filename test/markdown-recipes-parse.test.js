import { parseRecipe, parseDuration } from '../plugins/markdown-recipes/parse-recipe.js';

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

import { parseRecipe, parseDuration } from '../plugins/markdown-recipes/parse-recipe.js';

const PESTLE = `# Butter Chickpeas

A vegan-friendly twist on butter chicken.

**Category** dinner

**Cuisine** american, indian

**Total Time** 1h 25m

**Prep Time** 10m

**Servings** 2.0

**Source** thealmondeater.com

## Ingredients

* 2 tbsp dairy free butter
* 1 small onion (diced)

## Instructions

1. Melt the butter.
2. Add the onion.

##  Nutrition

**Calories** 271 kcal

**Saturated Fat** 8 g

**Protein** 8 g

## Notes
*Calories are per serving.

*Use plain tomato sauce.
`;

describe('parseRecipe', () => {
  const recipe = parseRecipe(PESTLE, 'fallback');

  test('reads the title, description and fields', () => {
    expect(recipe.title).toBe('Butter Chickpeas');
    expect(recipe.description).toBe('A vegan-friendly twist on butter chicken.');
    expect(recipe.categories).toEqual(['dinner']);
    expect(recipe.cuisines).toEqual(['american', 'indian']);
    expect(recipe.total_time_minutes).toBe(85);
    expect(recipe.extra).toEqual({ prep_time_minutes: 10 });
    expect(recipe.servings).toBe('2.0');
    expect(recipe.recipe_source).toBe('thealmondeater.com');
  });

  test('reads ingredient and instruction lists without their markers', () => {
    expect(recipe.ingredients).toEqual(['2 tbsp dairy free butter', '1 small onion (diced)']);
    expect(recipe.instructions).toEqual(['Melt the butter.', 'Add the onion.']);
  });

  test('reads nutrition, including the numbers it indexes', () => {
    expect(recipe.nutrition).toEqual({ calories: '271 kcal', saturated_fat: '8 g', protein: '8 g' });
    expect(recipe.calories).toBe(271);
    expect(recipe.protein_grams).toBe(8);
  });

  test('keeps notes as written', () => {
    expect(recipe.notes).toBe('*Calories are per serving.\n\n*Use plain tomato sauce.');
  });

  test('falls back to the file name and empty values for a bare file', () => {
    const bare = parseRecipe('Just some text.\n', 'Grandma Soup');
    expect(bare.title).toBe('Grandma Soup');
    expect(bare.description).toBe('Just some text.');
    expect(bare.ingredients).toEqual([]);
    expect(bare.nutrition).toEqual({});
    expect(bare.calories).toBeNull();
    expect(bare.total_time_minutes).toBeNull();
  });
});

describe('parseDuration', () => {
  test.each([
    ['25m', 25],
    ['1h', 60],
    ['8h 10m', 490],
    ['', null],
    ['about a while', null]
  ])('%s → %s', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes);
  });
});

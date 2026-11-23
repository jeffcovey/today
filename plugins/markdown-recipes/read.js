#!/usr/bin/env node

// Syncs recipe markdown files from the vault into the recipes table.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseRecipe } from './parse-recipe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const rootDir = path.resolve(projectRoot, config.recipes_directory || 'vault/recipes');
const fileFilter = process.env.FILE_FILTER || '';

function findRecipeFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findRecipeFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

const filterFiles = fileFilter
  ? fileFilter.split(',').map(f => path.join(projectRoot, f.trim()))
  : null;

const hasMissingRecipe = filterFiles?.some(f => {
  const relativePath = path.relative(rootDir, f);
  const isInsideRecipeDirectory = relativePath && !relativePath.startsWith(`..${path.sep}`)
    && relativePath !== '..' && !path.isAbsolute(relativePath);
  return isInsideRecipeDirectory && f.endsWith('.md') && !fs.existsSync(f);
});

const recipeFiles = filterFiles && !hasMissingRecipe
  ? filterFiles.filter(f => fs.existsSync(f) && f.endsWith('.md') && f.startsWith(rootDir + path.sep))
  : findRecipeFiles(rootDir);

const entries = [];
for (const filePath of recipeFiles) {
  const relativePath = path.relative(projectRoot, filePath);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error reading ${filePath}: ${error.message}`);
    continue;
  }

  const recipe = parseRecipe(content, path.basename(filePath, '.md'));
  entries.push({
    id: relativePath,
    title: recipe.title,
    description: recipe.description,
    categories: JSON.stringify(recipe.categories),
    cuisines: JSON.stringify(recipe.cuisines),
    total_time_minutes: recipe.total_time_minutes,
    servings: recipe.servings,
    recipe_source: recipe.recipe_source,
    ingredients: JSON.stringify(recipe.ingredients),
    instructions: JSON.stringify(recipe.instructions),
    nutrition: Object.keys(recipe.nutrition).length ? JSON.stringify(recipe.nutrition) : null,
    calories: recipe.calories,
    protein_grams: recipe.protein_grams,
    notes: recipe.notes,
    metadata: JSON.stringify({ file_path: relativePath, ...recipe.extra })
  });
}

// A full read (no FILE_FILTER) omits files_processed so the loader replaces
// every row, which drops recipes whose files were deleted or renamed.
const output = { entries };
if (filterFiles && !hasMissingRecipe) {
  output.files_processed = recipeFiles.map(f => path.relative(projectRoot, f));
  output.incremental = true;
}

console.log(JSON.stringify(output));

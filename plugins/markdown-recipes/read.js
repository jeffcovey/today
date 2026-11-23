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

const inLibrary = f => f.endsWith('.md') && f.startsWith(rootDir + path.sep);
const requested = fileFilter
  ? fileFilter.split(',').map(f => path.resolve(projectRoot, f.trim())).filter(inLibrary)
  : null;

// The loader only removes rows for deleted files on a full read, so a
// filtered read that names a vanished recipe (deleted or renamed) reads
// everything instead.
const incremental = requested !== null && requested.every(f => fs.existsSync(f));
const recipeFiles = incremental ? requested : findRecipeFiles(rootDir);

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
    keywords: JSON.stringify(recipe.keywords),
    prep_time_minutes: recipe.prep_time_minutes,
    cook_time_minutes: recipe.cook_time_minutes,
    total_time_minutes: recipe.total_time_minutes,
    servings: recipe.servings,
    url: recipe.url,
    author: recipe.author,
    image_url: recipe.image_url,
    rating: recipe.rating,
    ingredients: JSON.stringify(recipe.ingredients),
    instructions: JSON.stringify(recipe.instructions),
    nutrition: Object.keys(recipe.nutrition).length ? JSON.stringify(recipe.nutrition) : null,
    calories: recipe.calories,
    protein_grams: recipe.protein_grams,
    notes: recipe.notes,
    date_added: recipe.date_added,
    metadata: JSON.stringify({ file_path: relativePath, ...recipe.extra })
  });
}

// A full read omits files_processed so the loader replaces every row.
const output = { entries };
if (incremental) {
  output.files_processed = recipeFiles.map(f => path.relative(projectRoot, f));
  output.incremental = true;
}

console.log(JSON.stringify(output));

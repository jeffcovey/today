#!/usr/bin/env node

// Pestle Recipes Plugin — imports .pestle export files into the recipes table

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../..');

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const sourceId = process.env.SOURCE_ID || 'pestle-recipes/default';

const inboxDirectory = config.inbox_directory || 'vault/inbox';
const recipesDirectory = config.recipes_directory || 'vault/recipes';

const inboxDir = path.join(PROJECT_ROOT, inboxDirectory);
const recipesDir = path.join(PROJECT_ROOT, recipesDirectory);

/** Convert ISO 8601 duration (PT10M, PT1H30M) to minutes */
function parseDuration(dur) {
  if (!dur) return null;
  const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return null;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

/** Parse one Pestle recipe object into a DB row */
function parseRecipe(raw) {
  const ingredients = (raw.recipeIngredient || []).map(ing => ({
    name: ing.name || '',
    quantity: ing.quantity ?? null,
    unit: ing.unit || null,
    text: ing.text || ing.name || ''
  }));

  const instructions = (raw.recipeInstructions || []).map(step =>
    typeof step === 'string' ? step : (step.text || '')
  ).filter(Boolean);

  const imageUrl = Array.isArray(raw.image) && raw.image.length > 0
    ? raw.image[0].url
    : (typeof raw.image === 'string' ? raw.image : null);

  const authorName = raw.author
    ? (typeof raw.author === 'string' ? raw.author : raw.author.name || null)
    : null;

  const addedAt = raw.dateAdded
    ? new Date(typeof raw.dateAdded === 'number' ? raw.dateAdded * 1000 : raw.dateAdded).toISOString()
    : null;

  return {
    id: raw.id || null,
    title: raw.name || 'Untitled',
    description: raw.description || null,
    author: authorName,
    url: raw.source || null,
    prep_time_minutes: parseDuration(raw.prepTime),
    cook_time_minutes: parseDuration(raw.cookTime),
    total_time_minutes: parseDuration(raw.totalTime),
    servings: raw.recipeYield != null ? String(raw.recipeYield) : null,
    categories: JSON.stringify(raw.recipeCategory || []),
    cuisines: JSON.stringify(raw.recipeCuisine || []),
    keywords: JSON.stringify(raw.keywords || []),
    ingredients: JSON.stringify(ingredients),
    instructions: JSON.stringify(instructions),
    nutrition: raw.nutrition ? JSON.stringify(raw.nutrition) : null,
    image_url: imageUrl,
    rating: raw.aggregateRating?.ratingValue ?? null,
    rating_count: raw.aggregateRating?.ratingCount ?? null,
    user_created: raw.userCreated ? 1 : 0,
    added_at: addedAt,
    metadata: null
  };
}

/** Collect all .pestle files from a directory (non-recursive) */
function findPestleFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.pestle'))
    .map(f => path.join(dir, f));
}

async function main() {
  const entries = [];
  const errors = [];
  const movedFiles = [];

  // Ensure recipes archive directory exists
  fs.mkdirSync(recipesDir, { recursive: true });

  // Collect .pestle files from both inbox and the recipes archive
  const inboxFiles = findPestleFiles(inboxDir);
  const archiveFiles = findPestleFiles(recipesDir);
  const allFiles = [...inboxFiles, ...archiveFiles];

  if (allFiles.length === 0) {
    process.stdout.write(JSON.stringify({ entries: [], metadata: { message: 'No .pestle files found' } }));
    return;
  }

  for (const filePath of allFiles) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      errors.push(`Failed to parse ${path.basename(filePath)}: ${err.message}`);
      continue;
    }

    if (!Array.isArray(raw)) {
      errors.push(`${path.basename(filePath)}: expected a JSON array, got ${typeof raw}`);
      continue;
    }

    for (const item of raw) {
      try {
        entries.push(parseRecipe(item));
      } catch (err) {
        errors.push(`Recipe "${item.name || item.id}": ${err.message}`);
      }
    }

    // Move inbox files to the recipes archive
    if (inboxFiles.includes(filePath)) {
      const dest = path.join(recipesDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
        movedFiles.push(path.basename(filePath));
      } catch (err) {
        errors.push(`Could not move ${path.basename(filePath)} to recipes dir: ${err.message}`);
      }
    }
  }

  const result = {
    entries,
    metadata: {
      files_processed: allFiles.length,
      recipes_imported: entries.length,
      moved_to_archive: movedFiles,
      ...(errors.length > 0 ? { errors } : {})
    }
  };

  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  process.stderr.write(`pestle-recipes read.js fatal: ${err.message}\n`);
  process.exit(1);
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readScript = path.join(repoRoot, 'plugins/markdown-recipes/read.js');
const recipesBin = path.join(repoRoot, 'bin/recipes');

describe('markdown-recipes read', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-recipes-'));
    fs.mkdirSync(path.join(root, 'vault/recipes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'vault/recipes/keep.md'), '# Keep\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function runReader(fileFilter) {
    const result = spawnSync(process.execPath, [readScript], {
      cwd: root,
      env: {
        ...process.env,
        PROJECT_ROOT: root,
        PLUGIN_CONFIG: JSON.stringify({ recipes_directory: 'vault/recipes' }),
        FILE_FILTER: fileFilter
      },
      encoding: 'utf8'
    });
    return { status: result.status, output: JSON.parse(result.stdout) };
  }

  test('a deleted recipe path triggers a full read', () => {
    const result = runReader('vault/recipes/deleted.md');

    expect(result.status).toBe(0);
    expect(result.output.entries.map(entry => entry.id)).toEqual(['vault/recipes/keep.md']);
    expect(result.output.files_processed).toBeUndefined();
    expect(result.output.incremental).toBeUndefined();
  });

  test('a missing markdown path outside the recipe directory stays incremental', () => {
    const result = runReader('vault/other/deleted.md');

    expect(result.status).toBe(0);
    expect(result.output.entries).toEqual([]);
    expect(result.output.files_processed).toEqual([]);
    expect(result.output.incremental).toBe(true);
  });

  test('show finds a recipe using the file path it prints', () => {
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, 'timezone = "UTC"\n');

    const filePath = 'vault/recipes/keep.md';
    fs.mkdirSync(path.join(root, '.data'), { recursive: true });
    const db = new Database(path.join(root, '.data/today.db'));
    db.exec(`CREATE TABLE recipes (
      id TEXT, title TEXT, description TEXT, categories TEXT, cuisines TEXT,
      total_time_minutes INTEGER, servings TEXT, recipe_source TEXT,
      ingredients TEXT, instructions TEXT, nutrition TEXT, calories REAL,
      protein_grams REAL, notes TEXT, metadata TEXT
    )`);
    db.prepare(`INSERT INTO recipes (
      id, title, description, categories, cuisines, ingredients, instructions, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'markdown-recipes/default:vault/recipes/keep.md',
      'Keep',
      null,
      '[]',
      '[]',
      JSON.stringify(['Water']),
      '[]',
      JSON.stringify({ file_path: filePath })
    );
    db.close();

    const result = spawnSync(process.execPath, [recipesBin, 'show', filePath], {
      cwd: root,
      env: { ...process.env, TODAY_CONFIG: configPath },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Keep');
    expect(result.stdout).toContain(`File: ${filePath}`);
    expect(result.stdout).toContain('Water');
  });
});

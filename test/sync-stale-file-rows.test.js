import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { syncPluginSource } from '../src/plugin-loader.js';
import { getSqlColumns } from '../src/plugin-schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Rows of files that are moved, deleted, emptied, or newly excluded must leave
// the cache; they used to survive even full syncs (#621).
describe('stale rows for files no longer in the source (#621)', () => {
  let tmp, vault, db, plugin, cfg, ctx;
  const SOURCE = 'markdown-tasks/local';

  const write = (rel, body) => {
    const file = path.join(vault, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const rel = (vaultRel) => path.relative(repoRoot, path.join(vault, vaultRel));
  const filesInDb = () => [...new Set(
    db.prepare('SELECT metadata FROM tasks WHERE source = ?').all(SOURCE)
      .map(r => path.relative(path.relative(repoRoot, vault), JSON.parse(r.metadata).file_path))
  )].sort();
  // A full read without touching the real vault-changes baseline: the plugin
  // only goes incremental when LAST_SYNC_TIME is set.
  const fullSync = async (config = cfg) => {
    db.prepare('UPDATE sync_metadata SET last_synced_at = NULL').run();
    return syncPluginSource(plugin, 'local', config, ctx, { _caller: 'test' });
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-rows-'));
    vault = path.join(tmp, 'vault');
    write('projects/drink-less.md', '- [ ] Pour it out\n- [ ] Buy seltzer\n');
    write('projects/keep.md', '- [ ] Stay\n');
    write('archive/old.md', '- [ ] Ancient\n');
    write('notes/archive/nested.md', '- [ ] Nested archive\n');
    write('exports/bear/note.md', '- [ ] Bear export\n');
    write('exports/other/note.md', '- [ ] Other export\n');
    write('templates/t.md', '- [ ] Template task\n');

    db = new Database(path.join(tmp, 'test.db'));
    db.exec(`CREATE TABLE tasks (${getSqlColumns('tasks')})`);
    db.exec(`CREATE TABLE sync_metadata (
      source TEXT PRIMARY KEY, sync_locked_at TEXT, sync_locked_by TEXT,
      last_synced_at TEXT, last_sync_files TEXT, entries_count INTEGER, extra_data TEXT)`);

    plugin = {
      name: 'markdown-tasks', type: 'tasks',
      _path: path.join(repoRoot, 'plugins', 'markdown-tasks'),
      commands: { read: './read.js' }
    };
    cfg = { directory: path.relative(repoRoot, vault), exclude_paths: 'templates,.obsidian' };
    ctx = { db, vaultPath: vault };
    await fullSync();
    expect(filesInDb()).toEqual([
      'archive/old.md', 'exports/bear/note.md', 'exports/other/note.md',
      'notes/archive/nested.md', 'projects/drink-less.md', 'projects/keep.md'
    ]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('full sync drops rows of a moved file', async () => {
    fs.mkdirSync(path.join(vault, 'projects/completed'));
    fs.renameSync(path.join(vault, 'projects/drink-less.md'), path.join(vault, 'projects/completed/drink-less.md'));
    await fullSync();
    expect(filesInDb()).toContain('projects/completed/drink-less.md');
    expect(filesInDb()).not.toContain('projects/drink-less.md');
  });

  test('full sync drops rows of a file emptied of tasks', async () => {
    write('projects/keep.md', 'No tasks here any more\n');
    await fullSync();
    expect(filesInDb()).not.toContain('projects/keep.md');
  });

  test('full sync drops rows of a newly excluded folder, at any depth', async () => {
    await fullSync({ ...cfg, exclude_paths: 'templates,.obsidian,archive,exports/bear' });
    expect(filesInDb()).toEqual(['exports/other/note.md', 'projects/drink-less.md', 'projects/keep.md']);
  });

  test('a config change forces a full read even when a sync time is recorded', async () => {
    // A recorded sync time would normally make the plugin incremental; the new
    // exclude_paths must reconcile anyway, without clearing sync_metadata.
    db.prepare(`UPDATE sync_metadata SET last_synced_at = datetime('now')`).run();
    await syncPluginSource(plugin, 'local', { ...cfg, exclude_paths: 'templates,archive' }, ctx, { _caller: 'test' });
    expect(filesInDb()).not.toContain('archive/old.md');
    expect(filesInDb()).not.toContain('notes/archive/nested.md');
  });

  test('a filtered sync of an excluded file drops its rows', async () => {
    const config = { ...cfg, exclude_paths: 'templates,archive' };
    const result = await syncPluginSource(plugin, 'local', config, ctx, {
      fileFilter: rel('archive/old.md'), _caller: 'test'
    });
    expect(result.success).toBe(true);
    expect(filesInDb()).not.toContain('archive/old.md');
    expect(filesInDb()).toContain('notes/archive/nested.md');
  });

  test('a filtered sync of an unrelated file drops rows of files gone from disk', async () => {
    fs.rmSync(path.join(vault, 'projects/drink-less.md'));
    write('projects/keep.md', '- [ ] Stay\n- [ ] Also stay\n');
    await syncPluginSource(plugin, 'local', cfg, ctx, { fileFilter: rel('projects/keep.md'), _caller: 'test' });
    expect(filesInDb()).not.toContain('projects/drink-less.md');
    expect(db.prepare('SELECT count(*) AS n FROM tasks WHERE id LIKE ?').get('%keep.md%').n).toBe(2);
  });

  describe('partial (incremental) reads', () => {
    let stubDir;
    const stub = (output) => {
      fs.writeFileSync(path.join(stubDir, 'read.js'),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(output))});\n`);
      fs.chmodSync(path.join(stubDir, 'read.js'), 0o755);
      return { ...plugin, _path: stubDir, commands: { read: './read.js' } };
    };
    beforeEach(() => { stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-stub-')); });
    afterEach(() => fs.rmSync(stubDir, { recursive: true, force: true }));

    test('keep rows of unprocessed files that still exist (#508), drop rows of deleted ones', async () => {
      fs.rmSync(path.join(vault, 'archive/old.md'));
      const p = stub({ entries: [], files_processed: [], incremental: true });
      await syncPluginSource(p, 'local', cfg, ctx, { _caller: 'test' });
      expect(filesInDb()).toEqual([
        'exports/bear/note.md', 'exports/other/note.md',
        'notes/archive/nested.md', 'projects/drink-less.md', 'projects/keep.md'
      ]);
    });

    test('an empty incremental read clears rows of the files it processed', async () => {
      const p = stub({ entries: [], files_processed: [rel('projects/keep.md')], incremental: true });
      await syncPluginSource(p, 'local', cfg, ctx, { _caller: 'test' });
      expect(filesInDb()).not.toContain('projects/keep.md');
      expect(filesInDb()).toContain('projects/drink-less.md');
    });
  });

  test('per-file deletes match the exact path, not a LIKE pattern', async () => {
    write('projects/a_b.md', '- [ ] Underscore\n');
    write('projects/aXb.md', '- [ ] Lookalike\n');
    write('projects/Keep.md', '- [ ] Capitalised\n');
    await fullSync();
    await syncPluginSource(plugin, 'local', cfg, ctx, {
      fileFilter: [rel('projects/a_b.md'), rel('projects/keep.md')].join(','), _caller: 'test'
    });
    expect(filesInDb()).toEqual(expect.arrayContaining(['projects/aXb.md', 'projects/Keep.md']));
  });
});

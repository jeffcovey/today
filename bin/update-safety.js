import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

function getGitPath(projectRoot, pathName, execSync) {
  const gitPath = execSync(`git rev-parse --git-path ${pathName}`, {
    cwd: projectRoot,
    encoding: 'utf8'
  }).trim();
  return isAbsolute(gitPath) ? gitPath : resolve(projectRoot, gitPath);
}

function findUpdateStash(projectRoot, token, execSync) {
  const stashList = execSync('git stash list --format=%gd%x09%H%x09%s', {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  const entry = stashList.split('\n').find(line => line.split('\t').at(-1)?.includes(token));
  const [ref, hash] = entry?.split('\t') || [];
  return /^stash@\{\d+\}$/.test(ref || '') && /^[a-f0-9]+$/i.test(hash || '')
    ? { ref, hash }
    : null;
}

export function ensureBetterSqliteBinding(projectRoot, execSync, loadDatabase = () => {
  const requireFromProject = createRequire(join(projectRoot, 'package.json'));
  return requireFromProject('better-sqlite3');
}) {
  const bindingLoads = () => {
    try {
      const Database = loadDatabase();
      const database = new Database(':memory:');
      database.close();
      return true;
    } catch {
      return false;
    }
  };

  if (bindingLoads()) return true;

  console.error('⚠️  better-sqlite3 is not loadable. Rebuilding its native binding...');
  try {
    execSync('npm rebuild better-sqlite3', { cwd: projectRoot, stdio: 'inherit' });
  } catch (error) {
    console.error('❌ Failed to rebuild better-sqlite3:', error.message);
    console.error('   Please run: npm rebuild better-sqlite3');
    return false;
  }

  if (bindingLoads()) return true;

  console.error('❌ better-sqlite3 is still not loadable after rebuilding.');
  console.error('   Please run: npm rebuild better-sqlite3');
  return false;
}

export function stashUpdateChanges(projectRoot, execSync) {
  const markerPath = getGitPath(projectRoot, 'today-update-stash', execSync);
  const token = `today-update-${randomUUID()}`;
  writeFileSync(markerPath, token, { mode: 0o600 });

  try {
    execSync(`git stash push --include-untracked -m "${token}"`, {
      cwd: projectRoot,
      stdio: 'pipe'
    });
  } catch (error) {
    unlinkSync(markerPath);
    throw error;
  }

  return { markerPath, token };
}

export function restoreUpdateStash(projectRoot, execSync, markerPath, token, logger = console) {
  let stashHash;
  try {
    stashHash = findUpdateStash(projectRoot, token, execSync);
  } catch (error) {
    logger.error(`⚠️  Could not find the update stash. Run: git stash list (${error.message})`);
    return false;
  }

  if (!stashHash) {
    unlinkSync(markerPath);
    return true;
  }

  try {
    execSync(`git stash pop ${stashHash.ref}`, { cwd: projectRoot, stdio: 'pipe' });
    unlinkSync(markerPath);
    return true;
  } catch {
    logger.error(`⚠️  Could not restore update stash ${stashHash.hash}. Run: git stash pop ${stashHash.ref}`);
    return false;
  }
}

export function recoverInterruptedUpdate(projectRoot, execSync, logger = console) {
  let canUpdate = true;

  try {
    const markerPath = getGitPath(projectRoot, 'today-update-stash', execSync);
    if (existsSync(markerPath)) {
      const token = readFileSync(markerPath, 'utf8').trim();
      if (token && !restoreUpdateStash(projectRoot, execSync, markerPath, token, logger)) {
        canUpdate = false;
      }
    }

    const mergeHeadPath = getGitPath(projectRoot, 'MERGE_HEAD', execSync);
    if (existsSync(mergeHeadPath)) {
      const mergeHeads = readFileSync(mergeHeadPath, 'utf8').trim().split(/\s+/);
      const indexIsClean = (() => {
        try {
          execSync('git diff --cached --quiet', { cwd: projectRoot, stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      })();
      const mergeIsComplete = mergeHeads.every(hash => (
        /^[a-f0-9]+$/i.test(hash)
        && (() => {
          try {
            execSync(`git merge-base --is-ancestor ${hash} HEAD`, { cwd: projectRoot, stdio: 'pipe' });
            return true;
          } catch {
            return false;
          }
        })()
      ));

      if (mergeIsComplete && indexIsClean) {
        execSync('git merge --quit', { cwd: projectRoot, stdio: 'pipe' });
        logger.log('ℹ️  Cleared completed merge state left by an interrupted update.');
      } else {
        logger.error('⚠️  An unfinished or unresolved merge is present. Resolve it before updating.');
        canUpdate = false;
      }
    }
  } catch (error) {
    logger.error(`⚠️  Could not check for an interrupted update: ${error.message}`);
    canUpdate = false;
  }

  return canUpdate;
}

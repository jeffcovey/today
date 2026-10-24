import path from 'path';

export function resolveVaultDirectory(directory, projectRoot) {
  let vaultDir = directory;
  for (const suffix of ['/**/*.md', '/*.md']) {
    if (vaultDir.endsWith(suffix)) {
      vaultDir = vaultDir.slice(0, -suffix.length);
      break;
    }
  }

  if (!vaultDir || /[*?\[\]]/.test(vaultDir)) {
    throw new Error(
      `markdownlint-cleanup: directory must be a directory root; glob patterns are not supported: ${directory}`
    );
  }

  return {
    vaultDir,
    absolutePath: path.resolve(projectRoot, vaultDir)
  };
}

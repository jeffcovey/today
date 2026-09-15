import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runGitSync } from '../src/git-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function writeFakeGit(binDir) {
  const scriptPath = path.join(binDir, 'git');
  writeFileSync(scriptPath, `#!/bin/sh
set -eu
cmd="$1"
shift || true
case "$cmd" in
  rev-parse)
    echo .git
    ;;
  pull)
    printf 'prompt=%s\naskpass=%s\n' "\${GIT_TERMINAL_PROMPT:-}" "\${GIT_ASKPASS:-}" > "$FAKE_GIT_ENV_LOG"
    if [ "\${GIT_TERMINAL_PROMPT:-}" = "0" ] && [ "\${GIT_ASKPASS:-}" = "/bin/echo" ]; then
      echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
      exit 1
    fi
    sleep 30
    ;;
  rebase)
    exit 0
    ;;
  push)
    exit 0
    ;;
  *)
    echo "unexpected git invocation: $cmd $*" >&2
    exit 99
    ;;
esac
`);
  chmodSync(scriptPath, 0o755);
}

describe('runGitSync', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('disables interactive credential prompts and fails fast with the git stderr', () => {
    tempDir = mkdtempSync(path.join(PROJECT_ROOT, 'tmp/git-sync-test-'));
    const vaultPath = path.join(tempDir, 'vault');
    const fakeBin = path.join(tempDir, 'bin');
    const logPath = path.join(tempDir, 'git-sync.log');
    const envLogPath = path.join(tempDir, 'git-env.log');

    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(path.join(vaultPath, '.git'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFakeGit(fakeBin);

    const startedAt = Date.now();
    const exitCode = runGitSync({
      vaultPath,
      logPath,
      env: {
        ...process.env,
        FAKE_GIT_ENV_LOG: envLogPath,
        PATH: `${fakeBin}:${process.env.PATH}`
      }
    });
    const elapsedMs = Date.now() - startedAt;

    expect(exitCode).toBe(2);
    expect(elapsedMs).toBeLessThan(5000);
    expect(readFileSync(envLogPath, 'utf8')).toContain('prompt=0');
    expect(readFileSync(envLogPath, 'utf8')).toContain('askpass=/bin/echo');
    expect(readFileSync(logPath, 'utf8')).toContain("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
  });
});

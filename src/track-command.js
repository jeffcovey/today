import { execFile } from 'child_process';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TRACK_COMMAND_CWD = path.join(__dirname, '..');
const TRACK_COMMAND_TIMEOUT_MS = 60000;

let trackCommandChain = Promise.resolve();

function execTrackCommand(args) {
  return new Promise((resolve, reject) => {
    execFile('bin/track', args, {
      cwd: TRACK_COMMAND_CWD,
      encoding: 'utf8',
      timeout: TRACK_COMMAND_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || ''}`.trim();
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Serialize bin/track so overlapping web requests can't race each other into
// inconsistent timer state, while still returning each caller's own outcome.
export function runTrackCommand(args) {
  const queued = trackCommandChain.catch(() => {});
  const result = queued.then(() => execTrackCommand(args));
  trackCommandChain = result;
  return result;
}

export function resetTrackCommandQueueForTests() {
  trackCommandChain = Promise.resolve();
}

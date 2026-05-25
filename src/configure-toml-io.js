/**
 * Shared TOML I/O for the configure TUIs.
 *
 * Both configure-ui.js and deployments-configure-ui.js write `today.toml`,
 * and both must use compare-and-swap so a TUI session that opens before an
 * external edit (eg. Unison merging in changes from another machine) does
 * not clobber that edit when it saves.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { writeFileAtomicCAS } from './fs-atomic.js';

const CONFIG_HEADER = `# Configuration for Today system
# Edit this file when your situation changes (e.g., when traveling)

`;

/**
 * Read config from `configPath`. Returns `{ config, raw }`; pass `raw` back
 * to writeConfigToml() as the CAS baseline. When the file is missing, `raw`
 * is `null` to match writeFileAtomicCAS's "no such file" sentinel — that way
 * a first-time save (file created externally between read and write) is
 * correctly flagged as a conflict.
 */
export function readConfigToml(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return { config: parseToml(raw), raw };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { config: {}, raw: null };
    }
    throw error;
  }
}

function getConfigFileLabel(configPath) {
  return path.basename(configPath) || configPath;
}

/**
 * Print a user-facing message explaining why a CAS write was refused.
 * `source` is the human-readable name of the TUI that hit the conflict.
 */
export function reportConfigConflict(configPath, source) {
  const configFileLabel = getConfigFileLabel(configPath);
  console.error('');
  console.error(`❌ ${configFileLabel} changed externally while ${source} was open.`);
  console.error('   Your edits were NOT saved — refusing to overwrite newer content.');
  console.error(`   File: ${configPath}`);
  console.error('   Reopen configure to pick up the external changes and retry.');
  console.error('');
}

/**
 * Write config to `configPath` using compare-and-swap against `originalRaw`.
 * Returns `{ content, conflict }`. On conflict the on-disk file is untouched;
 * the caller is expected to surface the conflict to the user.
 */
export function writeConfigToml(configPath, config, originalRaw) {
  let tomlOutput = stringifyToml(config);

  // Convert ai_instructions back to triple-quoted multi-line strings
  tomlOutput = tomlOutput.replace(
    /^(ai_instructions\s*=\s*)"((?:[^"\\]|\\.)*)"/gm,
    (match, prefix, content) => {
      if (!content.includes('\\n')) return match;
      const unescaped = content
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trimEnd();
      return `${prefix}"""\n${unescaped}\n"""`;
    }
  );

  const newContent = CONFIG_HEADER + tomlOutput;
  const { conflict } = writeFileAtomicCAS(configPath, newContent, originalRaw);
  return { content: newContent, conflict };
}

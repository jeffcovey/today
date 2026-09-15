import fs from 'fs';
import path from 'path';
import { execGroup } from './process-group.js';

const OUTPUT_LINE_LIMIT = 5;

function summarizeOutput(output) {
  const text = output?.toString().trim();
  if (!text) return '';
  return text.split('\n').slice(-OUTPUT_LINE_LIMIT).join('\n');
}

function formatCommandFailure(description, error) {
  const details = [];
  if (error?.code !== undefined) details.push(`exit code ${error.code}`);
  if (error?.signal) details.push(`signal ${error.signal}`);

  let header = `❌ ${description} failed`;
  if (details.length > 0) {
    header += ` (${details.join(', ')})`;
  }

  const stderr = summarizeOutput(error?.stderr);
  const stdout = summarizeOutput(error?.stdout);

  if (!stderr && !stdout) {
    const fallback = error?.message || String(error);
    return `${header}: ${fallback}`;
  }

  const lines = [header];
  if (stderr) lines.push(stderr);
  if (stdout) {
    lines.push('stdout:');
    lines.push(stdout);
  }
  return lines.join('\n');
}

export async function runCommand(command, description, options) {
  const {
    projectRoot,
    env = process.env,
    jitterMs = 0,
    timeoutMs,
    existsSync = fs.existsSync,
    logger = console,
    exec = execGroup,
  } = options;

  if (existsSync(path.join(projectRoot, 'SYNC_DISABLED')) && command.includes('sync')) {
    const timestamp = new Date().toISOString();
    logger.log(`\n[${timestamp}] SKIPPED: ${description}`);
    logger.log('⚠️  Sync is disabled to prevent data loss. Check GitHub repository.');
    return;
  }

  if (jitterMs > 0) {
    const delay = Math.floor(Math.random() * jitterMs);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  const timestamp = new Date().toISOString();
  logger.log(`\n[${timestamp}] Running: ${description}`);

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: projectRoot,
      env,
      timeoutMs
    });

    if (stdout) {
      logger.log(`✅ ${description} completed:`);
      logger.log(summarizeOutput(stdout));
    }

    if (stderr) {
      logger.error(`⚠️ Warnings from ${description}:`);
      logger.error(stderr);
    }
  } catch (error) {
    logger.error(formatCommandFailure(description, error));
  }
}

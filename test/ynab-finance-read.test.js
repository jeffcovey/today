import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const readScript = path.join(repoRoot, 'plugins', 'ynab-finance', 'read.js');

function makeRegisterCsv(payee) {
  return [
    'Account,Date,Payee,Category Group/Category,Memo,Outflow,Inflow,Cleared,Flag',
    `Checking,2026-05-01,${payee},Food: Groceries,,10.00,0.00,Cleared,`
  ].join('\n');
}

function makePlanCsv() {
  return [
    'Month,Category Group/Category,Budgeted,Activity,Available',
    '2026-05,Food: Groceries,100.00,-10.00,90.00'
  ].join('\n');
}

function createYnabZip(logsDir, zipFilename, budgetName, timestamp, payee) {
  const zip = new AdmZip();
  zip.addFile(`${budgetName} as of ${timestamp} - Register.csv`, Buffer.from(makeRegisterCsv(payee), 'utf8'));
  zip.addFile(`${budgetName} as of ${timestamp} - Plan.csv`, Buffer.from(makePlanCsv(), 'utf8'));
  zip.writeZip(path.join(logsDir, zipFilename));
}

function runReadPlugin(projectRoot, pluginConfig = {}) {
  return JSON.parse(execFileSync('node', [readScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SOURCE_ID: 'ynab-finance/test',
      PLUGIN_CONFIG: JSON.stringify({
        logs_directory: 'vault/logs',
        ...pluginConfig
      })
    }
  }));
}

describe('ynab-finance read plugin ZIP handling', () => {
  let tempRoot;
  let logsDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ynab-finance-read-'));
    logsDir = path.join(tempRoot, 'vault', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('extracts latest YNAB export ZIP and uses extracted CSVs', () => {
    const budgetName = 'Household Budget';
    const oldTimestamp = '2026-05-01 10-00';
    const newTimestamp = '2026-05-02 09-30';
    const oldRegister = path.join(logsDir, `${budgetName} as of ${oldTimestamp} - Register.csv`);
    const oldPlan = path.join(logsDir, `${budgetName} as of ${oldTimestamp} - Plan.csv`);

    fs.writeFileSync(oldRegister, makeRegisterCsv('Old CSV'));
    fs.writeFileSync(oldPlan, makePlanCsv());
    const oldTime = new Date('2026-05-01T10:00:00Z');
    fs.utimesSync(oldRegister, oldTime, oldTime);
    fs.utimesSync(oldPlan, oldTime, oldTime);

    createYnabZip(
      logsDir,
      `YNAB Export - ${budgetName} as of ${newTimestamp}.zip`,
      budgetName,
      newTimestamp,
      'From Zip'
    );

    const result = runReadPlugin(tempRoot, { cleanup_old_files: false });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].payee).toBe('From Zip');
    expect(result.metadata.latest_zip_file).toBe(`YNAB Export - ${budgetName} as of ${newTimestamp}.zip`);
    expect(result.metadata.extracted_from_zip).toEqual(
      expect.arrayContaining([
        `${budgetName} as of ${newTimestamp} - Register.csv`,
        `${budgetName} as of ${newTimestamp} - Plan.csv`
      ])
    );
  });

  test('cleanup_old_files deletes older ZIP archives after successful processing', () => {
    const budgetName = 'Travel Budget';
    const oldTimestamp = '2026-05-01 09-30';
    const newTimestamp = '2026-05-02 09-30';
    const oldZip = `${budgetName} as of ${oldTimestamp}.zip`;
    const newZip = `YNAB Export - ${budgetName} as of ${newTimestamp}.zip`;

    createYnabZip(logsDir, oldZip, budgetName, oldTimestamp, 'Old Zip');
    const oldZipPath = path.join(logsDir, oldZip);
    const oldTime = new Date('2026-05-01T09:30:00Z');
    fs.utimesSync(oldZipPath, oldTime, oldTime);

    createYnabZip(logsDir, newZip, budgetName, newTimestamp, 'New Zip');

    runReadPlugin(tempRoot, { cleanup_old_files: true });

    expect(fs.existsSync(path.join(logsDir, oldZip))).toBe(false);
    expect(fs.existsSync(path.join(logsDir, newZip))).toBe(true);
  });
});

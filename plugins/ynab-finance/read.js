#!/usr/bin/env node

// YNAB Finance Plugin - Read YNAB CSV exports
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with financial transaction entries

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const sourceId = process.env.SOURCE_ID || 'ynab-finance/default';

// Import database for budget allocations insertion
let Database;
try {
  Database = require('better-sqlite3');
} catch (error) {
  console.error('Warning: better-sqlite3 not available, budget allocations will not be saved');
}

const logsDirectory = config.logs_directory || 'vault/logs';
const cleanupOldFiles = config.cleanup_old_files !== false; // Default true
const retentionDays = config.retention_days || 365;
const ynabCsvPattern = /^(.+) as of (\d{4}-\d{2}-\d{2} \d{2}-\d{2}) - (Register|Plan)\.csv$/;
const ynabZipPattern = /^(?:YNAB Export - )?(.+) as of (\d{4}-\d{2}-\d{2} \d{2}-\d{2})\.zip$/;

const logsDir = path.join(projectRoot, logsDirectory);

// Check if directory exists
if (!fs.existsSync(logsDir)) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: `Logs directory not found: ${logsDirectory}`,
      hint: 'Create the directory and add YNAB export files'
    }
  }));
  process.exit(0);
}

// Find YNAB CSV files (both Register and Plan)
function findYnabFiles(dir) {
  const files = { register: [], plan: [] };

  try {
    const entries = fs.readdirSync(dir);

    for (const entry of entries) {
      const csvMatch = entry.match(ynabCsvPattern);
      if (!csvMatch) {
        continue;
      }

      const [, budgetName, timestamp, fileType] = csvMatch;
      const fullPath = path.join(dir, entry);
      const stats = fs.statSync(fullPath);
      const fileInfo = {
        path: fullPath,
        budgetName,
        timestamp,
        filename: entry,
        mtime: stats.mtime,
        type: fileType.toLowerCase()
      };

      if (fileType === 'Register') {
        files.register.push(fileInfo);
      } else if (fileType === 'Plan') {
        files.plan.push(fileInfo);
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${error.message}`);
  }

  // Sort by newest first
  files.register.sort((a, b) => b.mtime - a.mtime);
  files.plan.sort((a, b) => b.mtime - a.mtime);

  return files;
}

// Find YNAB ZIP exports
function findYnabZipFiles(dir) {
  const zipFiles = [];

  try {
    const entries = fs.readdirSync(dir);

    for (const entry of entries) {
      const zipMatch = entry.match(ynabZipPattern);
      if (!zipMatch) {
        continue;
      }

      const [, budgetName, timestamp] = zipMatch;
      const fullPath = path.join(dir, entry);
      const stats = fs.statSync(fullPath);

      zipFiles.push({
        path: fullPath,
        budgetName,
        timestamp,
        filename: entry,
        mtime: stats.mtime,
        type: 'zip'
      });
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${error.message}`);
  }

  zipFiles.sort((a, b) => b.mtime - a.mtime);
  return zipFiles;
}

// Extract latest YNAB ZIP export (if present)
function extractLatestYnabZip(dir) {
  const zipFiles = findYnabZipFiles(dir);
  if (zipFiles.length === 0) {
    return { zipFiles, extractedFiles: [], extractionSkipped: false };
  }

  const latestZip = zipFiles[0];
  const expectedRegisterFile = `${latestZip.budgetName} as of ${latestZip.timestamp} - Register.csv`;
  const expectedPlanFile = `${latestZip.budgetName} as of ${latestZip.timestamp} - Plan.csv`;
  const expectedRegisterPath = path.join(dir, expectedRegisterFile);
  const expectedPlanPath = path.join(dir, expectedPlanFile);

  if (fs.existsSync(expectedRegisterPath) && fs.existsSync(expectedPlanPath)) {
    return {
      zipFiles,
      extractedFiles: [],
      latestZip,
      extractionSkipped: true
    };
  }

  const zip = new AdmZip(latestZip.path);
  const zipEntries = zip.getEntries();
  let registerEntry;
  let planEntry;

  for (const zipEntry of zipEntries) {
    if (zipEntry.isDirectory) {
      continue;
    }

    const entryName = path.basename(zipEntry.entryName);
    const csvMatch = entryName.match(ynabCsvPattern);
    if (!csvMatch) {
      continue;
    }

    const [, budgetName, timestamp, fileType] = csvMatch;
    if (budgetName !== latestZip.budgetName || timestamp !== latestZip.timestamp) {
      continue;
    }

    if (fileType === 'Register') {
      registerEntry = zipEntry;
    } else if (fileType === 'Plan') {
      planEntry = zipEntry;
    }
  }

  if (!registerEntry || !planEntry) {
    throw new Error(`ZIP ${latestZip.filename} did not contain both Register.csv and Plan.csv files`);
  }

  fs.writeFileSync(expectedRegisterPath, registerEntry.getData());
  fs.writeFileSync(expectedPlanPath, planEntry.getData());

  return {
    zipFiles,
    extractedFiles: [expectedRegisterFile, expectedPlanFile],
    latestZip,
    extractionSkipped: false
  };
}

// Parse CSV content (simple CSV parser for YNAB format)
function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length === 0) return [];

  const header = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === header.length) {
      const row = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = values[j];
      }
      rows.push(row);
    }
  }

  return rows;
}

// Parse a single CSV line (handles quoted fields)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 2;
      } else {
        // Toggle quotes
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current);
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }

  result.push(current);
  return result;
}

// Convert YNAB amount to number (handles $100.00 format)
function parseAmount(amountStr) {
  if (!amountStr) return 0;

  // Remove currency symbol and commas
  const cleaned = amountStr.replace(/[$,]/g, '');
  const amount = parseFloat(cleaned);

  return isNaN(amount) ? 0 : amount;
}

// Convert YNAB date to YYYY-MM-DD format
function parseDate(dateStr) {
  if (!dateStr) return null;

  // Try various date formats that YNAB might use
  const date = new Date(dateStr);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().split('T')[0];
}

// Generate unique ID for transaction
function generateTransactionId(transaction, filePath, rowIndex) {
  const hash = crypto.createHash('md5');
  const data = `${transaction.date}-${transaction.account}-${transaction.payee}-${transaction.amount}-${rowIndex}`;
  hash.update(data);
  return `${sourceId}:${path.basename(filePath)}:${rowIndex}:${hash.digest('hex').substring(0, 8)}`;
}

// Convert YNAB month to YYYY-MM-01 format
function parseMonth(monthStr) {
  if (!monthStr) return null;

  // Try various date formats that YNAB might use for months
  const date = new Date(monthStr + '-01');

  if (isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().split('T')[0].substring(0, 7) + '-01';
}

// Generate unique ID for budget allocation
function generateAllocationId(allocation, filePath, rowIndex) {
  const hash = crypto.createHash('md5');
  const data = `${allocation.month}-${allocation.category_group}-${allocation.category}-${rowIndex}`;
  hash.update(data);
  return `${sourceId}:${path.basename(filePath)}:${rowIndex}:${hash.digest('hex').substring(0, 8)}`;
}

// Convert YNAB budget allocation to our format
function convertAllocation(ynabAllocation, filePath, rowIndex) {
  const month = parseMonth(ynabAllocation.Month);

  // Skip allocations without valid months
  if (!month) {
    return null;
  }

  // Check retention period
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - (retentionDays / 30)); // Convert days to months roughly
  const allocationDate = new Date(month);

  if (allocationDate < cutoffDate) {
    return null;
  }

  // Parse amounts - YNAB Plan.csv has Budgeted, Activity, Available columns
  const budgeted = parseAmount(ynabAllocation.Budgeted || ynabAllocation.Assigned);
  const activity = parseAmount(ynabAllocation.Activity);
  const available = parseAmount(ynabAllocation.Available);

  // Parse category (YNAB format: "Group/Category" or "Group: Category")
  const categoryFull = ynabAllocation['Category Group/Category'] || ynabAllocation.Category || '';
  let category = '';
  let categoryGroup = '';

  if (categoryFull) {
    // Handle "Group: Category" format
    if (categoryFull.includes(': ')) {
      const parts = categoryFull.split(': ');
      categoryGroup = parts[0];
      category = parts.slice(1).join(': ');
    }
    // Handle "Group/Category" format
    else if (categoryFull.includes('/')) {
      const parts = categoryFull.split('/');
      categoryGroup = parts[0];
      category = parts.slice(1).join('/');
    }
    // Single category
    else {
      category = categoryFull;
    }
  }

  return {
    id: generateAllocationId({ month, category_group: categoryGroup, category }, filePath, rowIndex),
    month,
    category_group: categoryGroup.trim(),
    category: category.trim(),
    assigned: budgeted, // Use "assigned" to match database schema
    activity,
    available,
    metadata: JSON.stringify({
      source_file: path.basename(filePath),
      row_index: rowIndex,
      ynab_category_full: categoryFull
    })
  };
}

// Convert YNAB transaction to our format
function convertTransaction(ynabTx, filePath, rowIndex) {
  const date = parseDate(ynabTx.Date);

  // Skip transactions without valid dates
  if (!date) {
    return null;
  }

  // Check retention period
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const txDate = new Date(date);

  if (txDate < cutoffDate) {
    return null;
  }

  // Parse amounts - YNAB has separate Outflow and Inflow columns
  const outflow = parseAmount(ynabTx.Outflow);
  const inflow = parseAmount(ynabTx.Inflow);

  // Convert to our format: negative for expenses, positive for income
  let amount = 0;
  if (inflow > 0) {
    amount = inflow;
  } else if (outflow > 0) {
    amount = -outflow;
  }

  // Parse category (YNAB format: "Group/Category" or "Group: Category")
  const categoryFull = ynabTx['Category Group/Category'] || ynabTx.Category || '';
  let category = '';
  let categoryGroup = '';

  if (categoryFull) {
    // Handle "Group: Category" format
    if (categoryFull.includes(': ')) {
      const parts = categoryFull.split(': ');
      categoryGroup = parts[0];
      category = parts.slice(1).join(': ');
    }
    // Handle "Group/Category" format
    else if (categoryFull.includes('/')) {
      const parts = categoryFull.split('/');
      categoryGroup = parts[0];
      category = parts.slice(1).join('/');
    }
    // Single category
    else {
      category = categoryFull;
    }
  }

  return {
    id: generateTransactionId({ date, account: ynabTx.Account, payee: ynabTx.Payee, amount }, filePath, rowIndex),
    date,
    account: ynabTx.Account || '',
    payee: ynabTx.Payee || '',
    category: category.trim(),
    category_group: categoryGroup.trim(),
    amount,
    memo: ynabTx.Memo || '',
    cleared: ynabTx.Cleared || '',
    flag: ynabTx.Flag || '',
    metadata: JSON.stringify({
      source_file: path.basename(filePath),
      row_index: rowIndex,
      ynab_category_full: categoryFull
    })
  };
}

// Extract latest ZIP export first (if present), then process CSV files
let zipExtraction = { zipFiles: [], extractedFiles: [] };
try {
  zipExtraction = extractLatestYnabZip(logsDir);
} catch (error) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      error: `Failed to extract YNAB ZIP export: ${error.message}`
    }
  }));
  process.exit(1);
}

const ynabZipFiles = zipExtraction.zipFiles;
const ynabFiles = findYnabFiles(logsDir);
const latestZip = ynabZipFiles[0];
const latestRegisterFile = latestZip
  ? ynabFiles.register.find(file => file.budgetName === latestZip.budgetName && file.timestamp === latestZip.timestamp) || null
  : ynabFiles.register[0] || null;
const latestPlanFile = latestZip
  ? ynabFiles.plan.find(file => file.budgetName === latestZip.budgetName && file.timestamp === latestZip.timestamp) || null
  : ynabFiles.plan[0] || null;

if (latestZip && (!latestRegisterFile || !latestPlanFile)) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      error: `Expected Register.csv and Plan.csv for latest ZIP ${latestZip.filename}`,
      extracted_from_zip: zipExtraction.extractedFiles
    }
  }));
  process.exit(1);
}

if (ynabFiles.register.length === 0 && ynabFiles.plan.length === 0) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: 'No YNAB CSV files found',
      hint: `Export your YNAB budget data and save Register.csv and Plan.csv files to ${logsDirectory}/`,
      pattern: 'Files should be named: "Budget Name as of YYYY-MM-DD HH-MM - Register.csv" and "Budget Name as of YYYY-MM-DD HH-MM - Plan.csv"'
    }
  }));
  process.exit(0);
}

const entries = [];
const budgetEntries = [];
let filesProcessed = [];

// Process Register.csv files (transactions)
if (latestRegisterFile) {
  try {
    const content = fs.readFileSync(latestRegisterFile.path, 'utf8');
    const rows = parseCSV(content);

    filesProcessed.push(path.relative(projectRoot, latestRegisterFile.path));

    for (let i = 0; i < rows.length; i++) {
      const transaction = convertTransaction(rows[i], latestRegisterFile.path, i + 2); // +2 for 1-based + header
      if (transaction) {
        entries.push(transaction);
      }
    }

    // Validate CSV header format for Register files
    const firstLine = content.split('\n')[0];
    const hasRequiredColumns = ['Account', 'Date', 'Payee', 'Outflow', 'Inflow'].every(col =>
      firstLine.includes(col)
    );

    if (!hasRequiredColumns) {
      console.log(JSON.stringify({
        entries: [],
        metadata: {
          error: `File ${latestRegisterFile.filename} does not appear to be a valid YNAB Register.csv export`,
          hint: 'Expected columns: Account, Date, Payee, Outflow, Inflow, etc.',
          header_found: firstLine
        }
      }));
      process.exit(1);
    }

  } catch (error) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        error: `Failed to process ${latestRegisterFile.filename}: ${error.message}`,
        register_files_found: ynabFiles.register.map(f => f.filename)
      }
    }));
    process.exit(1);
  }
}

// Process Plan.csv files (budget allocations)
if (latestPlanFile) {
  try {
    const content = fs.readFileSync(latestPlanFile.path, 'utf8');
    const rows = parseCSV(content);

    filesProcessed.push(path.relative(projectRoot, latestPlanFile.path));

    for (let i = 0; i < rows.length; i++) {
      const allocation = convertAllocation(rows[i], latestPlanFile.path, i + 2); // +2 for 1-based + header
      if (allocation) {
        budgetEntries.push(allocation);
      }
    }

    // Validate CSV header format for Plan files
    const firstLine = content.split('\n')[0];
    const hasRequiredColumns = ['Month', 'Activity', 'Available'].every(col =>
      firstLine.includes(col)
    ) && (firstLine.includes('Budgeted') || firstLine.includes('Assigned'));

    if (!hasRequiredColumns) {
      console.log(JSON.stringify({
        entries: [],
        metadata: {
          error: `File ${latestPlanFile.filename} does not appear to be a valid YNAB Plan.csv export`,
          hint: 'Expected columns: Month, Assigned (or Budgeted), Activity, Available, etc.',
          header_found: firstLine
        }
      }));
      process.exit(1);
    }

  } catch (error) {
    console.log(JSON.stringify({
      entries: [],
      metadata: {
        error: `Failed to process ${latestPlanFile.filename}: ${error.message}`,
        plan_files_found: ynabFiles.plan.map(f => f.filename)
      }
    }));
    process.exit(1);
  }
}

// Cleanup old files if enabled
if (cleanupOldFiles) {
  const filesToDelete = [
    ...ynabFiles.register.slice(1),
    ...ynabFiles.plan.slice(1),
    ...ynabZipFiles.slice(1)
  ]; // All except the latest of each type
  const deletedFiles = [];

  for (const file of filesToDelete) {
    try {
      fs.unlinkSync(file.path);
      deletedFiles.push(file.filename);
    } catch (error) {
      console.error(`Warning: Could not delete ${file.filename}: ${error.message}`);
    }
  }

  if (deletedFiles.length > 0) {
    console.error(`Cleaned up ${deletedFiles.length} old YNAB files: ${deletedFiles.join(', ')}`);
  }
}

// Insert budget allocations directly into database if we have budget entries
if (budgetEntries.length > 0 && Database) {
  try {
    const dbPath = path.join(projectRoot, '.data', 'today.db');
    const db = new Database(dbPath);

    // Clear existing budget allocations for this source
    const deleteStmt = db.prepare('DELETE FROM budget_allocations WHERE source = ?');
    deleteStmt.run(sourceId);

    // Insert new budget allocations
    const insertStmt = db.prepare(`
      INSERT INTO budget_allocations (id, source, month, category, category_group, assigned, activity, available, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const allocation of budgetEntries) {
      insertStmt.run(
        allocation.id,
        sourceId,
        allocation.month,
        allocation.category,
        allocation.category_group,
        allocation.assigned,
        allocation.activity,
        allocation.available,
        allocation.metadata
      );
    }

    db.close();
    console.error(`Inserted ${budgetEntries.length} budget allocations into database`);

  } catch (error) {
    console.error(`Warning: Failed to insert budget allocations: ${error.message}`);
  }
}

// Build metadata
const metadata = {
  files_processed: filesProcessed,
  transactions_found: entries.length,
  budget_allocations_found: budgetEntries.length,
  retention_days: retentionDays
};

// Add file info for processed files
if (latestRegisterFile) {
  metadata.latest_register_file = latestRegisterFile.filename;
  metadata.register_budget_name = latestRegisterFile.budgetName;
  metadata.register_timestamp = latestRegisterFile.timestamp;
}
if (latestPlanFile) {
  metadata.latest_plan_file = latestPlanFile.filename;
  metadata.plan_budget_name = latestPlanFile.budgetName;
  metadata.plan_timestamp = latestPlanFile.timestamp;
}
if (ynabZipFiles.length > 0) {
  metadata.latest_zip_file = ynabZipFiles[0].filename;
  metadata.zip_budget_name = ynabZipFiles[0].budgetName;
  metadata.zip_timestamp = ynabZipFiles[0].timestamp;
  metadata.zip_extraction_skipped = zipExtraction.extractionSkipped;
}
if (zipExtraction.extractedFiles.length > 0) {
  metadata.extracted_from_zip = zipExtraction.extractedFiles;
}

// Output results (transactions go through normal plugin flow)
console.log(JSON.stringify({
  entries,
  metadata
}));

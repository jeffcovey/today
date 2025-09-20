#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Database path
const DB_PATH = path.join(__dirname, '..', '.data', 'today.db');
const JOURNAL_PATH = path.join(__dirname, '..', 'vault', 'logs', 'Journal.json');
const JOURNAL_BACKUP_PATH = path.join(__dirname, '..', 'vault', 'logs', 'Journal.json.backup');

// Colors for output
const colors = {
  green: '\x1b[32m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

function printInfo(message) {
  console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
}

function printSuccess(message) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function printError(message) {
  console.log(`${colors.red}✗${colors.reset} ${message}`);
}

// Create diary table with migrations
function createDiaryTable(db) {
  return new Promise((resolve, reject) => {
    // Create the diary table if it doesn't exist
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS diary (
        id TEXT PRIMARY KEY,
        creation_date TEXT NOT NULL,
        modified_date TEXT,
        text TEXT NOT NULL,
        starred INTEGER DEFAULT 0,
        location_name TEXT,
        location_latitude REAL,
        location_longitude REAL,
        weather_temp_celsius REAL,
        weather_conditions TEXT,
        tags TEXT,
        journal_file_modified TEXT,
        UNIQUE(id)
      )
    `;
    
    db.run(createTableSQL, (err) => {
      if (err) {
        reject(err);
      } else {
        // Create indexes for common queries
        db.run(`CREATE INDEX IF NOT EXISTS idx_diary_creation_date ON diary(creation_date)`, (err) => {
          if (err) console.warn('Warning: Could not create date index:', err.message);
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_diary_starred ON diary(starred)`, (err) => {
          if (err) console.warn('Warning: Could not create starred index:', err.message);
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_diary_location ON diary(location_name)`, (err) => {
          if (err) console.warn('Warning: Could not create location index:', err.message);
        });
        
        resolve();
      }
    });
  });
}

// Check if we need to sync (journal file newer than newest DB entry)
async function needsSync(db) {
  // Check if journal file exists
  if (!fs.existsSync(JOURNAL_PATH)) {
    printError('Journal.json not found at vault/logs/Journal.json');
    return false;
  }
  
  // Get journal file modification time
  const journalStats = fs.statSync(JOURNAL_PATH);
  const journalModified = journalStats.mtime.toISOString();
  
  return new Promise((resolve) => {
    // Get the most recent sync time from database
    db.get(
      `SELECT MAX(journal_file_modified) as last_sync FROM diary`,
      (err, row) => {
        if (err || !row || !row.last_sync) {
          printInfo('No previous sync found, full sync needed');
          resolve({ needsSync: true, journalModified });
        } else if (row.last_sync < journalModified) {
          printInfo(`Journal updated since last sync (${row.last_sync})`);
          resolve({ needsSync: true, journalModified });
        } else {
          printInfo('Journal has not changed since last sync');
          resolve({ needsSync: false, journalModified });
        }
      }
    );
  });
}

// Validate and repair JSON if needed
function validateAndRepairJSON(jsonString) {
  try {
    // First attempt: parse as-is
    return JSON.parse(jsonString);
  } catch (error) {
    printInfo('JSON parse error detected, attempting to repair...');

    // Check for common truncation issues
    let repairedJSON = jsonString;

    // Count opening and closing braces/brackets
    const openBraces = (jsonString.match(/{/g) || []).length;
    const closeBraces = (jsonString.match(/}/g) || []).length;
    const openBrackets = (jsonString.match(/\[/g) || []).length;
    const closeBrackets = (jsonString.match(/]/g) || []).length;

    // If JSON appears truncated (missing closing braces/brackets)
    if (openBraces > closeBraces || openBrackets > closeBrackets) {
      printInfo(`Detected truncated JSON: ${openBraces} { vs ${closeBraces} }, ${openBrackets} [ vs ${closeBrackets} ]`);

      // Try to find the last complete entry
      const entriesMatch = jsonString.match(/"entries"\s*:\s*\[/);
      if (entriesMatch) {
        // Find the last complete object before truncation
        const lastCompleteEntry = jsonString.lastIndexOf('},\n    {');

        if (lastCompleteEntry > -1) {
          // Truncate at the last complete entry
          repairedJSON = jsonString.substring(0, lastCompleteEntry + 1);
        } else {
          // No complete entries found, look for any valid JSON object
          // Find the position of the entries array start
          const entriesArrayStart = jsonString.indexOf('[', entriesMatch.index);

          // Look for last properly closed object
          let lastValidClose = -1;
          let depth = 0;
          let inString = false;
          let escaped = false;

          for (let i = entriesArrayStart + 1; i < jsonString.length; i++) {
            const char = jsonString[i];

            if (escaped) {
              escaped = false;
              continue;
            }

            if (char === '\\') {
              escaped = true;
              continue;
            }

            if (char === '"' && !inString) {
              inString = true;
            } else if (char === '"' && inString) {
              inString = false;
            } else if (!inString) {
              if (char === '{') depth++;
              else if (char === '}') {
                depth--;
                if (depth === 0) {
                  // Found a complete object at top level
                  lastValidClose = i;
                }
              }
            }
          }

          if (lastValidClose > -1) {
            repairedJSON = jsonString.substring(0, lastValidClose + 1);
            // Remove any trailing comma if present
            if (repairedJSON.endsWith(',')) {
              repairedJSON = repairedJSON.slice(0, -1);
            }
          }
        }
      }

      // Add closing braces/brackets as needed
      const missingBraces = openBraces - closeBraces;
      const missingBrackets = openBrackets - closeBrackets;

      // Ensure proper structure closure
      if (missingBrackets > 0 && !repairedJSON.trim().endsWith(']')) {
        repairedJSON = repairedJSON.trim();
        // Remove trailing incomplete data
        if (repairedJSON.endsWith(',')) {
          repairedJSON = repairedJSON.slice(0, -1);
        }
        repairedJSON += '\n  ]';
      }

      if (missingBraces > 0) {
        repairedJSON += '\n}';
      }

      // Add any additional missing closures
      for (let i = 1; i < missingBrackets; i++) {
        repairedJSON += ']';
      }
      for (let i = 1; i < missingBraces; i++) {
        repairedJSON += '}';
      }
    }

    // Try parsing the repaired JSON
    try {
      const repaired = JSON.parse(repairedJSON);
      printSuccess('JSON repaired successfully');
      return repaired;
    } catch (repairError) {
      // If repair failed, try more aggressive fixes
      printInfo('Standard repair failed, attempting deep repair...');

      // Remove any incomplete entries at the end
      const lastValidEntry = repairedJSON.lastIndexOf('},');
      if (lastValidEntry > -1) {
        const beforeLastEntry = repairedJSON.substring(0, lastValidEntry + 1);
        const afterLastEntry = repairedJSON.substring(lastValidEntry + 1);

        // Check if there's an incomplete entry after the last valid one
        if (afterLastEntry.includes('"uuid"') && !afterLastEntry.includes('}')) {
          // Remove incomplete entry
          repairedJSON = beforeLastEntry + '\n  ]\n}';

          try {
            const deepRepaired = JSON.parse(repairedJSON);
            printSuccess('JSON deep repair successful');
            return deepRepaired;
          } catch (e) {
            // Fall through to error
          }
        }
      }

      throw new Error(`Unable to repair JSON: ${error.message}`);
    }
  }
}

// Sync journal entries to database
async function syncJournal(db, journalModified) {
  printInfo('Reading Day One journal export...');

  // Read the raw JSON file
  const rawJSON = fs.readFileSync(JOURNAL_PATH, 'utf8');

  // Create backup before any modifications
  if (fs.existsSync(JOURNAL_PATH)) {
    fs.copyFileSync(JOURNAL_PATH, JOURNAL_BACKUP_PATH);
    printInfo('Created backup at Journal.json.backup');
  }

  // Validate and repair JSON if needed
  let journalData;
  try {
    journalData = validateAndRepairJSON(rawJSON);

    // If repair was needed, save the repaired version
    if (JSON.stringify(journalData) !== rawJSON) {
      fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journalData, null, 2));
      printInfo('Saved repaired JSON to Journal.json');
    }
  } catch (error) {
    printError(`Failed to parse or repair journal JSON: ${error.message}`);
    printInfo('Backup preserved at Journal.json.backup');
    throw error;
  }

  const entries = journalData.entries || [];

  printInfo(`Found ${entries.length} total entries in journal`);
  
  // Prepare insert/update statement
  const upsertSQL = `
    INSERT OR REPLACE INTO diary (
      id, creation_date, modified_date, text, starred,
      location_name, location_latitude, location_longitude,
      weather_temp_celsius, weather_conditions, tags,
      journal_file_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  let processed = 0;
  let errors = 0;
  
  const stmt = db.prepare(upsertSQL);
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
          reject(err);
          return;
        }

        entries.forEach(entry => {
          try {
            // Skip entries without text
            if (!entry.text) {
              console.log(`Skipping entry ${entry.uuid}: no text content`);
              return;
            }

            const location = entry.location || {};
            const weather = entry.weather || {};
            const tags = entry.tags ? JSON.stringify(entry.tags) : null;

            stmt.run(
              entry.uuid,
              entry.creationDate,
              entry.modifiedDate || entry.creationDate,
              entry.text,
              entry.starred ? 1 : 0,
              location.localityName || null,
              location.latitude || null,
              location.longitude || null,
              weather.temperatureCelsius || null,
              weather.conditionsDescription || null,
              tags,
              journalModified
            );
            processed++;
          } catch (e) {
            console.error(`Error processing entry ${entry.uuid}:`, e.message);
            errors++;
          }
        });

        stmt.finalize((err) => {
          if (err) {
            db.run('ROLLBACK', () => {
              reject(err);
            });
          } else {
            db.run('COMMIT', (err) => {
              if (err) {
                db.run('ROLLBACK', () => {
                  reject(err);
                });
              } else {
                resolve({ processed, errors, total: entries.length });
              }
            });
          }
        });
      });
    });
  });
}

// Get diary statistics
async function getDiaryStats(db) {
  return new Promise((resolve) => {
    db.all(
      `SELECT 
        COUNT(*) as total_entries,
        COUNT(CASE WHEN starred = 1 THEN 1 END) as starred_entries,
        COUNT(DISTINCT location_name) as unique_locations,
        MIN(creation_date) as earliest_entry,
        MAX(creation_date) as latest_entry,
        COUNT(CASE WHEN datetime(creation_date) >= datetime('now', '-7 days') THEN 1 END) as recent_week,
        COUNT(CASE WHEN datetime(creation_date) >= datetime('now', '-30 days') THEN 1 END) as recent_month
      FROM diary`,
      (err, rows) => {
        if (err) {
          console.error('Error getting stats:', err);
          resolve(null);
        } else {
          resolve(rows[0]);
        }
      }
    );
  });
}

// Main sync function
async function main() {
  // Create/connect to database
  const db = new sqlite3.Database(DB_PATH);
  
  try {
    // Create table if needed
    await createDiaryTable(db);
    
    // Check if sync is needed
    const syncInfo = await needsSync(db);
    
    if (!syncInfo.needsSync) {
      printSuccess('Diary is already up to date');
      
      // Show stats
      const stats = await getDiaryStats(db);
      if (stats) {
        printInfo(`Total entries: ${stats.total_entries}`);
        printInfo(`Recent (7 days): ${stats.recent_week}, (30 days): ${stats.recent_month}`);
        printInfo(`Starred entries: ${stats.starred_entries}`);
      }
      
      db.close(() => {});
      return;
    }
    
    // Perform sync
    printInfo('Syncing diary entries to database...');
    const result = await syncJournal(db, syncInfo.journalModified);
    
    if (result.errors > 0) {
      printError(`Sync completed with ${result.errors} errors`);
    } else {
      printSuccess(`Successfully synced ${result.processed} diary entries`);
    }
    
    // Show updated stats
    const stats = await getDiaryStats(db);
    if (stats) {
      console.log('');
      printInfo('📊 Diary Statistics:');
      printInfo(`  Total entries: ${stats.total_entries}`);
      printInfo(`  Date range: ${stats.earliest_entry?.split('T')[0]} to ${stats.latest_entry?.split('T')[0]}`);
      printInfo(`  Recent entries: ${stats.recent_week} (week), ${stats.recent_month} (month)`);
      printInfo(`  Starred entries: ${stats.starred_entries}`);
      printInfo(`  Unique locations: ${stats.unique_locations}`);
    }
    
  } catch (error) {
    printError(`Sync failed: ${error.message}`);

    // Offer to restore from backup if available
    if (fs.existsSync(JOURNAL_BACKUP_PATH)) {
      printInfo('A backup of the journal exists at Journal.json.backup');
      printInfo('You can restore it manually if needed');
    }

    process.exit(1);
  } finally {
    db.close(() => {});
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { syncJournal, createDiaryTable };
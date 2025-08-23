#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Database path
const DB_PATH = path.join(__dirname, '..', '.data', 'today.db');
const JOURNAL_PATH = path.join(__dirname, '..', 'vault', 'logs', 'Journal.json');

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

// Sync journal entries to database
async function syncJournal(db, journalModified) {
  printInfo('Reading Day One journal export...');
  
  const journalData = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
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
      db.run('BEGIN TRANSACTION');
      
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
          db.run('ROLLBACK');
          reject(err);
        } else {
          db.run('COMMIT', (err) => {
            if (err) {
              reject(err);
            } else {
              resolve({ processed, errors, total: entries.length });
            }
          });
        }
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
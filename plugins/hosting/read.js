#!/usr/bin/env node

/**
 * Hosting Plugin - Context Display
 *
 * Shows rental property information with:
 * - Auto name extraction from URLs with daily updates
 * - Multiple listing URLs
 * - Calendar integration via calendar source references
 * - Email activity tracking
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import Database from 'better-sqlite3';

// Get plugin configuration from environment
const configStr = process.env.PLUGIN_CONFIG || '{}';
let config;
try {
  config = JSON.parse(configStr);
} catch (error) {
  console.log(JSON.stringify({
    error: `Invalid plugin configuration: ${error.message}`,
    properties: [],
    message: "Configuration error"
  }));
  process.exit(1);
}

// Get project root and database path
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const dbPath = path.join(projectRoot, '.data', 'today.db');
const sourceId = process.env.SOURCE_ID || 'hosting/default';

let db = null;
if (fs.existsSync(dbPath)) {
  try {
    db = new Database(dbPath);
  } catch (error) {
    // Ignore database errors
  }
}

// Function to fetch URL content for name extraction
async function fetchUrlContent(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    let resolved = false;
    let request;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        if (request) {
          request.destroy();
        }
      }
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3000); // Reduced to 3 second timeout

    try {
      request = client.get(url, { timeout: 3000 }, (response) => {
        if (resolved) return;

        if (response.statusCode !== 200) {
          cleanup();
          clearTimeout(timeoutId);
          resolve(null);
          return;
        }

        let data = '';
        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          if (resolved) return;
          data += chunk;
          // Stop after getting enough data to find the title - increased for SPA content
          if (data.length > 100000) {
            cleanup();
            clearTimeout(timeoutId);
            resolve(data);
          }
        });

        response.on('end', () => {
          if (resolved) return;
          cleanup();
          clearTimeout(timeoutId);
          resolve(data);
        });

        response.on('error', () => {
          cleanup();
          clearTimeout(timeoutId);
          resolve(null);
        });
      });

      request.on('error', () => {
        cleanup();
        clearTimeout(timeoutId);
        resolve(null);
      });

      request.on('timeout', () => {
        cleanup();
        clearTimeout(timeoutId);
        resolve(null);
      });

    } catch (error) {
      cleanup();
      clearTimeout(timeoutId);
      resolve(null);
    }
  });
}

// Function to extract property name from URL content
function extractNameFromHtml(html, url) {
  if (!html) return null;

  // For Airbnb, try to find property name in JSON data
  if (url.includes('airbnb.com')) {
    // Try multiple JSON patterns that might contain the property name
    const jsonPatterns = [
      /"name"\s*:\s*"([^"]+)"/i,
      /"title"\s*:\s*"([^"]+)"/i,
      /"localizedName"\s*:\s*"([^"]+)"/i,
      /"p3_summary_title"\s*:\s*"([^"]+)"/i
    ];

    for (const pattern of jsonPatterns) {
      const match = html.match(pattern);
      if (match) {
        let name = match[1].trim();
        // Clean up escape sequences
        name = name.replace(/\\u[\dA-F]{4}/gi, (match) => {
          return String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16));
        });
        name = name.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

        // Clean up and skip generic titles
        if (name && name.length > 5 && !name.includes('Airbnb') && !name.includes('undefined')) {
          // Remove common Airbnb location and listing suffixes
          name = name.replace(/\s*-\s*Houses for Rent.*$/i, '');
          name = name.replace(/\s*-\s*Apartments for Rent.*$/i, '');
          name = name.replace(/\s*-\s*.*in\s+[\w\s,]+$/i, '');
          name = name.replace(/\s*in\s+[\w\s,]+,?\s*United States.*$/i, '');

          return name.trim();
        }
      }
    }
  }

  // Try traditional title tag as fallback
  const titleMatch = html.match(/<title[^>]*>([^<]+)</i);
  if (titleMatch) {
    let title = titleMatch[1].trim();

    // Clean up common patterns
    if (url.includes('airbnb.com')) {
      title = title.replace(/\s*-\s*Airbnb.*$/i, '');
      title = title.replace(/\s*\|\s*Airbnb.*$/i, '');
    } else if (url.includes('vrbo.com')) {
      title = title.replace(/\s*-\s*VRBO.*$/i, '');
      title = title.replace(/\s*\|\s*VRBO.*$/i, '');
    }

    // Remove common suffixes
    title = title.replace(/\s*-\s*[^-]*rental[^-]*$/i, '');
    title = title.replace(/\s*-\s*vacation rental$/i, '');

    return title.trim();
  }

  return null;
}

// Function to get stored name update info
function getNameUpdateInfo() {
  if (!db) return {};

  try {
    const stmt = db.prepare(`
      SELECT extra_data
      FROM sync_metadata
      WHERE source = ?
    `);
    const result = stmt.get(sourceId);

    if (result && result.extra_data) {
      const metadata = JSON.parse(result.extra_data);
      return metadata.name_updates || {};
    }
  } catch (error) {
    // Ignore errors
  }

  return {};
}

// Function to store name update info and extracted name
function storeNameUpdateInfo(nameUpdates, extractedNames = null) {
  if (!db) return;

  try {
    const existingStmt = db.prepare('SELECT extra_data FROM sync_metadata WHERE source = ?');
    const existing = existingStmt.get(sourceId);

    let metadata = { name_updates: nameUpdates };
    if (existing && existing.extra_data) {
      const existingMetadata = JSON.parse(existing.extra_data);
      metadata = { ...existingMetadata, name_updates: nameUpdates };

      // Only update extracted_names if provided, otherwise preserve existing
      if (extractedNames !== null) {
        metadata.extracted_names = extractedNames;
      }
    } else {
      // New metadata
      if (extractedNames !== null) {
        metadata.extracted_names = extractedNames;
      }
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO sync_metadata (source, last_synced_at, extra_data)
      VALUES (?, datetime('now'), ?)
    `);
    stmt.run(sourceId, JSON.stringify(metadata));
  } catch (error) {
    // Ignore errors
  }
}

// Function to get stored extracted name
function getStoredExtractedName(sourceKey) {
  if (!db) return null;

  try {
    const stmt = db.prepare(`
      SELECT extra_data
      FROM sync_metadata
      WHERE source = ?
    `);
    const result = stmt.get(sourceId);

    if (result && result.extra_data) {
      const metadata = JSON.parse(result.extra_data);
      return metadata.extracted_names?.[sourceKey] || null;
    }
  } catch (error) {
    // Ignore errors
  }

  return null;
}

// Function to check if we should update name (once per day)
function shouldUpdateName(nameUpdates, sourceKey) {
  const today = new Date().toISOString().split('T')[0];
  const lastCheck = nameUpdates[sourceKey];
  return !lastCheck || lastCheck !== today;
}

// Function to get occupancy from calendar source in events database
function getOccupancyFromCalendarSource(calendarSource, propertyName) {
  if (!db || !calendarSource) return [];

  try {
    const stmt = db.prepare(`
      SELECT title, start_date, end_date, description, location
      FROM events
      WHERE source = ?
        AND date(end_date) >= date('now')
        AND date(start_date) <= date('now', '+30 days')
      ORDER BY start_date
    `);

    const events = stmt.all(calendarSource);

    return events.map(event => {
      // Extract reservation URL from description if present
      let reservationUrl = null;
      if (event.description) {
        const urlMatch = event.description.match(/Reservation URL:\s*(https:\/\/[^\s\n]+)/);
        if (urlMatch) {
          reservationUrl = urlMatch[1];
        }
      }

      return {
        start: event.start_date,
        end: event.end_date,
        title: event.title,
        description: event.description,
        location: event.location,
        reservationUrl: reservationUrl
      };
    });
  } catch (error) {
    return [];
  }
}

// Function to validate calendar source exists and provide helpful feedback
function validateCalendarSource(calendarSource) {
  if (!calendarSource) return { valid: true, message: null };

  if (!db) return { valid: true, message: null }; // Can't validate without database

  try {
    // Get all available calendar sources
    const allSourcesStmt = db.prepare("SELECT DISTINCT source FROM events WHERE source LIKE 'public-calendars/%' LIMIT 20");
    const allSources = allSourcesStmt.all().map(row => row.source);

    if (allSources.includes(calendarSource)) {
      // Source exists, check if it has events
      const eventsStmt = db.prepare('SELECT COUNT(*) as count FROM events WHERE source = ? LIMIT 1');
      const result = eventsStmt.get(calendarSource);
      return { valid: true, message: result.count === 0 ? `Calendar source "${calendarSource}" exists but has no events yet.` : null };
    } else if (allSources.length > 0) {
      // Source doesn't exist, show available options
      return {
        valid: false,
        message: `Calendar source "${calendarSource}" not found. Available sources: ${allSources.join(', ')}`
      };
    } else {
      // No calendar sources in database at all
      return {
        valid: false,
        message: `Calendar source "${calendarSource}" not found. No calendar sources found in database.`
      };
    }
  } catch (error) {
    return { valid: true, message: null }; // Don't block on validation errors
  }
}

// Function to update property status in config.toml
function updatePropertyStatus(sourceKey, newStatus) {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const configPath = path.join(projectRoot, 'config.toml');

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const sectionPattern = new RegExp(`(\\[plugins\\.hosting\\.${sourceKey}\\][\\s\\S]*?)status\\s*=\\s*"[^"]*"`, 'g');

    const updatedContent = configContent.replace(sectionPattern, (match, beforeStatus) => {
      return beforeStatus + `status = "${newStatus}"`;
    });

    fs.writeFileSync(configPath, updatedContent, 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to update status: ${error.message}`);
    return false;
  }
}

// Function to determine automatic status based on calendar events and timing
function determineAutomaticStatus(calendarEvents, currentStatus, checkinTime, checkoutTime) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTimeStr = now.toTimeString().slice(0, 5); // HH:MM format

  // Find active reservation (ongoing or starting today)
  const activeReservation = calendarEvents.find(event => {
    const startDate = event.start.split('T')[0];
    const endDate = event.end.split('T')[0];
    return startDate <= today && endDate >= today;
  });

  // Find reservation ending today
  const reservationEndingToday = calendarEvents.find(event => {
    const endDate = event.end.split('T')[0];
    return endDate === today;
  });

  // Check if past check-in time
  const isPastCheckinTime = currentTimeStr >= checkinTime;

  // Determine new status
  if (activeReservation && isPastCheckinTime) {
    // Active reservation and past check-in time → should be Occupied
    return 'Occupied';
  } else if (reservationEndingToday && currentStatus === 'Occupied') {
    // Reservation ending today and currently Occupied → should be Dirty
    return 'Dirty';
  }

  // No automatic change needed
  return null;
}

// Function to get recent emails mentioning a property name
function getRecentEmails(propertyName) {
  if (!db || !propertyName) return [];

  try {
    const stmt = db.prepare(`
      SELECT subject, from_address, from_name, date, snippet
      FROM email
      WHERE date > datetime('now', '-30 days')
        AND (
          subject LIKE ? OR
          text_content LIKE ? OR
          snippet LIKE ?
        )
      ORDER BY date DESC
      LIMIT 10
    `);

    const searchPattern = `%${propertyName}%`;
    const emails = stmt.all(searchPattern, searchPattern, searchPattern);

    return emails.map(email => ({
      date: email.date.split('T')[0],
      subject: email.subject || '(no subject)',
      from: email.from_name || email.from_address,
      snippet: email.snippet ? email.snippet.substring(0, 100) + '...' : ''
    }));
  } catch (error) {
    return [];
  }
}

// Main processing
async function processProperty() {
  const nameUpdates = getNameUpdateInfo();
  const sourceKey = sourceId.split('/').pop();

  // Determine property name
  let propertyName = config.name;
  let nameSource = 'manual';

  if (config.auto_name_from_url && config.primary_url) {
    if (shouldUpdateName(nameUpdates, sourceKey)) {
      try {
        // Check URL for updated name with timeout protection
        const html = await Promise.race([
          fetchUrlContent(config.primary_url),
          new Promise(resolve => setTimeout(() => resolve(null), 4000))
        ]);

        const extractedName = extractNameFromHtml(html, config.primary_url);

        if (extractedName) {
          propertyName = extractedName;
          nameSource = 'url';

          // Store both check date and extracted name
          nameUpdates[sourceKey] = new Date().toISOString().split('T')[0];
          const extractedNames = { [sourceKey]: extractedName };
          storeNameUpdateInfo(nameUpdates, extractedNames);
        } else {
          // Failed to extract name - use fallback
          propertyName = propertyName || `Property (${sourceKey})`;
          nameSource = 'fallback';

          // Update check date but don't store extracted name
          nameUpdates[sourceKey] = new Date().toISOString().split('T')[0];
          storeNameUpdateInfo(nameUpdates);
        }
      } catch (error) {
        // Network error - use fallback
        propertyName = propertyName || `Property (${sourceKey})`;
        nameSource = 'fallback';

        // Still update check date to prevent constant retries
        nameUpdates[sourceKey] = new Date().toISOString().split('T')[0];
        storeNameUpdateInfo(nameUpdates);
      }
    } else {
      // Not time to check - use previously extracted name if available
      const storedName = getStoredExtractedName(sourceKey);
      if (storedName) {
        propertyName = storedName;
        nameSource = 'url';
      } else {
        propertyName = propertyName || `Property (${sourceKey})`;
        nameSource = propertyName === `Property (${sourceKey})` ? 'fallback' : 'manual';
      }
    }
  }

  // Validate we have a name
  if (!propertyName) {
    throw new Error('Property name is required when auto_name_from_url is false');
  }

  // Validate and get calendar occupancy from referenced calendar source
  const calendarValidation = validateCalendarSource(config.calendar_source);
  const calendarEvents = getOccupancyFromCalendarSource(config.calendar_source, propertyName);

  // Automatic status management based on reservations and timing
  let currentStatus = config.status || 'Prepared';
  const checkinTime = config.checkin_time || '15:00';
  const checkoutTime = config.checkout_time || '11:00';

  const automaticStatus = determineAutomaticStatus(calendarEvents, currentStatus, checkinTime, checkoutTime);
  if (automaticStatus && automaticStatus !== currentStatus) {
    const updateSuccess = updatePropertyStatus(sourceKey, automaticStatus);
    if (updateSuccess) {
      currentStatus = automaticStatus;
      console.error(`  🔄 Status automatically changed to "${automaticStatus}" for ${sourceKey}`);
    }
  }

  // Get recent emails
  const recentEmails = getRecentEmails(propertyName);

  // Build property object
  const property = {
    name: propertyName,
    name_source: nameSource,
    status: currentStatus,
    checkin_time: config.checkin_time || '15:00',
    checkout_time: config.checkout_time || '11:00',
    primary_url: config.primary_url || null,
    additional_urls: config.additional_urls || [],
    calendar_source: config.calendar_source || null,
    calendar_events: calendarEvents,
    calendar_validation: calendarValidation,
    recent_emails: recentEmails
  };

  return property;
}

// Format context output
function formatPropertyContext(property) {
  const lines = [];

  lines.push(`## ${property.name}`);
  lines.push(`- Status: ${property.status}`);
  lines.push(`- Check-in: ${property.checkin_time}, Check-out: ${property.checkout_time}`);

  if (property.primary_url) {
    lines.push(`- Primary URL: ${property.primary_url}`);
  }

  if (property.additional_urls && property.additional_urls.length > 0) {
    lines.push(`- Additional URLs: ${property.additional_urls.length}`);
    for (const url of property.additional_urls) {
      lines.push(`  • ${url}`);
    }
  }

  if (property.calendar_source) {
    lines.push(`- Calendar source: ${property.calendar_source}`);

    // Show validation warning if calendar source is invalid
    if (property.calendar_validation && !property.calendar_validation.valid) {
      lines.push(`  ⚠️  ${property.calendar_validation.message}`);
    }

    if (property.calendar_events && property.calendar_events.length > 0) {
      lines.push(`- Calendar events: ${property.calendar_events.length}`);
      for (const event of property.calendar_events.slice(0, 3)) {
        const startDate = new Date(event.start).toLocaleDateString();
        const endDate = new Date(event.end).toLocaleDateString();
        const dateRange = startDate === endDate ? startDate : `${startDate} - ${endDate}`;
        if (event.reservationUrl) {
          lines.push(`  • ${dateRange}: ${event.title} (${event.reservationUrl})`);
        } else {
          lines.push(`  • ${dateRange}: ${event.title}`);
        }
      }
      if (property.calendar_events.length > 3) {
        lines.push(`  • ... and ${property.calendar_events.length - 3} more`);
      }
    } else {
      lines.push("- No upcoming calendar events");
    }
  }

  if (property.recent_emails && property.recent_emails.length > 0) {
    lines.push(`- Recent emails: ${property.recent_emails.length}`);
    for (const email of property.recent_emails.slice(0, 3)) {
      lines.push(`  • ${email.date}: "${email.subject}" from ${email.from}`);
    }
    if (property.recent_emails.length > 3) {
      lines.push(`  • ... and ${property.recent_emails.length - 3} more`);
    }
  } else {
    lines.push("- No recent emails found");
  }

  return lines.join('\n');
}

// Execute with timeout (for name extraction only now)
const executeWithTimeout = () => {
  return Promise.race([
    processProperty(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Script timeout after 8 seconds')), 8000)
    )
  ]);
};

executeWithTimeout()
  .then(property => {
    const output = {
      context: formatPropertyContext(property),
      property,
      message: `1 property: ${property.name} (${property.status})`,
      ai_instructions: "When the user asks to change a property status (e.g., 'mark [property] as occupied'), edit the status field in config.toml under the corresponding [plugins.hosting.*] section. Valid statuses: Dirty, Prepared, Occupied."
    };

    console.log(JSON.stringify(output));
  })
  .catch(error => {
    const output = {
      error: error.message,
      properties: [],
      message: "Configuration error"
    };
    console.log(JSON.stringify(output));
  })
  .finally(() => {
    if (db) {
      try { db.close(); } catch (e) {}
    }
  });
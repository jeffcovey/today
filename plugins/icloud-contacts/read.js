#!/usr/bin/env node

// Sync contacts from iCloud CardDAV to contacts table
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata

import { autoDotenvx } from '../../bin/lib/dotenvx-loader.js';
autoDotenvx();

import { createDAVClient } from 'tsdav';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');

// Parse vCard format
function parseVCard(vCardText) {
  const contact = {};
  const lines = vCardText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle line continuations
    while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
      line += lines[i + 1].substring(1);
      i++;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex);
      const value = line.substring(colonIndex + 1);

      // Parse common vCard fields
      // Note: Order matters! Check longer prefixes before shorter ones (NOTE before N)
      if (key.startsWith('FN')) {
        contact.full_name = value.trim();
      } else if (key.startsWith('NICKNAME')) {
        contact.nickname = value.trim();
      } else if (key.startsWith('NOTE')) {
        contact.notes = value.trim().replace(/\\n/g, '\n');
      } else if (key === 'N' || key.startsWith('N;')) {
        // N format: LastName;FirstName;MiddleName;Prefix;Suffix
        const parts = value.split(';');
        contact.last_name = parts[0]?.trim() || '';
        contact.first_name = parts[1]?.trim() || '';
      } else if (key.startsWith('EMAIL')) {
        if (!contact.emails) contact.emails = [];
        const email = value.trim();
        contact.emails.push(email);
        if (!contact.primary_email || key.includes('PREF')) {
          contact.primary_email = email;
        }
      } else if (key.startsWith('TEL')) {
        if (!contact.phones) contact.phones = [];
        const phone = value.trim();
        contact.phones.push(phone);
        if (!contact.primary_phone || key.includes('PREF')) {
          contact.primary_phone = phone;
        }
      } else if (key.startsWith('ORG')) {
        contact.organization = value.trim();
      } else if (key.startsWith('TITLE')) {
        contact.job_title = value.trim();
      } else if (key.startsWith('BDAY')) {
        contact.birthday = value.trim();
      } else if (key.startsWith('ADR')) {
        // Parse address for location
        const parts = value.split(';');
        if (parts.length >= 6) {
          contact.location_city = parts[3]?.trim() || '';
          contact.location_state = parts[4]?.trim() || '';
          contact.location_country = parts[6]?.trim() || '';
        }
      } else if (key === 'UID') {
        contact.id = value.trim();
      }
    }
  }

  return contact;
}

// Sync from iCloud
async function synciCloudContacts() {
  if (!config.apple_id || !config.app_password) {
    return {
      error: 'iCloud not configured',
      message: 'Configure apple_id and app_password'
    };
  }

  // Create DAV client
  const client = await createDAVClient({
    serverUrl: 'https://contacts.icloud.com',
    credentials: { username: config.apple_id, password: config.app_password },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  });

  // Fetch address books
  const addressBooks = await client.fetchAddressBooks();
  if (!addressBooks || addressBooks.length === 0) {
    return { error: 'No address books found' };
  }

  // Fetch vCards from the first (default) address book
  const vcards = await client.fetchVCards({
    addressBook: addressBooks[0],
  });

  if (!vcards || vcards.length === 0) {
    return { error: 'No contacts found in address book' };
  }

  // Parse vCards
  const contacts = [];
  for (const vcard of vcards) {
    if (vcard.data) {
      const contact = parseVCard(vcard.data);
      if (contact && contact.full_name) {
        // Generate ID if not provided
        if (!contact.id) {
          contact.id = `icloud:${contact.full_name.replace(/\s+/g, '_').toLowerCase()}`;
        }

        // Store all emails and phones as metadata
        if (contact.emails || contact.phones) {
          contact.metadata = JSON.stringify({
            emails: contact.emails || [],
            phones: contact.phones || [],
          });
        }

        // Clean up temporary arrays
        delete contact.emails;
        delete contact.phones;

        contacts.push(contact);
      }
    }
  }

  return { contacts, count: contacts.length };
}

// Main execution
async function main() {
  try {
    const result = await synciCloudContacts();

    if (result.error) {
      console.log(JSON.stringify({
        entries: [],
        metadata: { error: result.error, message: result.message }
      }));
      process.exit(0);
    }

    console.log(JSON.stringify({
      entries: result.contacts,
      metadata: {
        synced: result.count,
        sync_time: new Date().toISOString()
      }
    }));

  } catch (error) {
    console.log(JSON.stringify({
      entries: [],
      metadata: { error: 'Unexpected error', message: error.message }
    }));
    process.exit(1);
  }
}

main();

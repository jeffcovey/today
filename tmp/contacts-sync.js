#!/usr/bin/env node

/**
 * iCloud Contacts Sync
 *
 * NOTE: This was extracted from bin/sync for migration to a plugin.
 * Syncs contacts from iCloud via CardDAV.
 *
 * Currently wraps: bin/contacts sync
 *
 * The full implementation is in bin/contacts (ContactsSync class) which:
 * - Connects to iCloud via CardDAV using tsdav library
 * - Parses vCard format
 * - Stores contacts in SQLite (contacts, contact_emails, contact_phones, contact_addresses)
 * - 4-hour cache duration
 *
 * TODO: Migrate to an icloud-contacts plugin:
 * - Type: 'contacts' (new plugin type)
 * - Move ContactsSync class to plugin
 * - Config: ICLOUD_USERNAME, ICLOUD_APP_PASSWORD
 * - read.js: sync and return contacts
 * - Schema: already exists in bin/contacts
 */

import { execSync } from 'child_process';

function syncContacts() {
  console.log('Syncing contacts...');

  try {
    execSync('bin/contacts sync', { stdio: 'pipe', timeout: 60000 });
    console.log('Contacts synced');
    return true;
  } catch (error) {
    console.error(`Contacts sync failed: ${error.message}`);
    return false;
  }
}

// Run if called directly
syncContacts();

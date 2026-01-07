#!/usr/bin/env node

// Write contacts to iCloud CardDAV
// Supports: create, update, delete operations
// Input: PLUGIN_CONFIG (JSON), ENTRY_JSON (JSON with action and data)
// Output: JSON with success/error status
//
// Supported actions:
// - create: Add a new contact
// - update: Update an existing contact (search + updates)
// - delete: Delete a contact (search criteria)

import { autoDotenvx } from '../../bin/lib/dotenvx-loader.js';
autoDotenvx();

import { createDAVClient } from 'tsdav';
import { randomUUID } from 'crypto';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const entryJson = process.env.ENTRY_JSON || '{}';

let entry;
try {
  entry = JSON.parse(entryJson);
} catch (error) {
  console.log(JSON.stringify({ success: false, error: `Invalid ENTRY_JSON: ${error.message}` }));
  process.exit(1);
}

const action = entry.action || 'create';

// Build vCard string from contact data
function buildVCard(contact) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${contact.id || randomUUID()}`,
  ];

  // Name fields
  const lastName = contact.last_name || '';
  const firstName = contact.first_name || '';
  lines.push(`N:${lastName};${firstName};;;`);

  if (contact.full_name) {
    lines.push(`FN:${contact.full_name}`);
  } else if (firstName || lastName) {
    lines.push(`FN:${firstName} ${lastName}`.trim());
  }

  if (contact.nickname) {
    lines.push(`NICKNAME:${contact.nickname}`);
  }

  // Organization
  if (contact.organization) {
    lines.push(`ORG:${contact.organization}`);
  }
  if (contact.job_title) {
    lines.push(`TITLE:${contact.job_title}`);
  }

  // Contact info
  if (contact.email || contact.primary_email) {
    lines.push(`EMAIL;TYPE=INTERNET:${contact.email || contact.primary_email}`);
  }
  if (contact.phone || contact.primary_phone) {
    lines.push(`TEL:${contact.phone || contact.primary_phone}`);
  }

  // Birthday (format: YYYY-MM-DD or YYYYMMDD)
  if (contact.birthday) {
    const bday = contact.birthday.replace(/-/g, '');
    lines.push(`BDAY:${bday}`);
  }

  // Address
  if (contact.location_city || contact.location_state || contact.location_country) {
    const addr = `;;${contact.street || ''};${contact.location_city || ''};${contact.location_state || ''};${contact.postal_code || ''};${contact.location_country || ''}`;
    lines.push(`ADR:${addr}`);
  }

  // Notes
  if (contact.notes) {
    const escapedNotes = contact.notes.replace(/\n/g, '\\n');
    lines.push(`NOTE:${escapedNotes}`);
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

// Get DAV client
async function getClient() {
  if (!config.apple_id || !config.app_password) {
    throw new Error('iCloud not configured: missing apple_id or app_password');
  }

  return createDAVClient({
    serverUrl: 'https://contacts.icloud.com',
    credentials: { username: config.apple_id, password: config.app_password },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  });
}

// Find vCard by search criteria (for update/delete)
async function findVCard(client, addressBook, search) {
  const vcards = await client.fetchVCards({ addressBook });
  const matches = [];

  for (const vcard of vcards) {
    if (!vcard.data) continue;

    // Parse basic fields for matching
    const fnMatch = vcard.data.match(/^FN:(.*)$/m);
    const emailMatch = vcard.data.match(/^EMAIL[^:]*:(.*)$/m);
    const uidMatch = vcard.data.match(/^UID:(.*)$/m);

    const fullName = fnMatch ? fnMatch[1].trim() : '';
    const email = emailMatch ? emailMatch[1].trim().toLowerCase() : '';
    const uid = uidMatch ? uidMatch[1].trim() : '';

    // Match by ID/UID first (exact match)
    if (search.id && uid === search.id) {
      return { vcard, fullName, email, uid, exact: true };
    }

    // Match by email (exact match)
    if (search.email && email === search.email.toLowerCase()) {
      matches.push({ vcard, fullName, email, uid });
      continue;
    }

    // Match by name (case-insensitive)
    if (search.name) {
      const searchName = search.name.toLowerCase();
      if (fullName.toLowerCase() === searchName ||
          fullName.toLowerCase().includes(searchName)) {
        matches.push({ vcard, fullName, email, uid });
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return { ...matches[0], exact: true };
  }

  // Multiple matches - return all for disambiguation
  return { multiple: true, matches };
}

// Create a new contact
async function createContact(contact) {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();

  if (!addressBooks || addressBooks.length === 0) {
    throw new Error('No address books found');
  }

  const vCardString = buildVCard(contact);
  const filename = `${randomUUID()}.vcf`;

  const result = await client.createVCard({
    addressBook: addressBooks[0],
    filename,
    vCardString,
  });

  if (!result.ok) {
    throw new Error(`Failed to create contact: ${result.statusText}`);
  }

  return {
    success: true,
    message: `Created contact: ${contact.full_name || contact.first_name}`,
    id: contact.id
  };
}

// Update an existing contact
async function updateContact(search, updates) {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();

  if (!addressBooks || addressBooks.length === 0) {
    throw new Error('No address books found');
  }

  const found = await findVCard(client, addressBooks[0], search);

  if (!found) {
    throw new Error(`No contact found matching: ${JSON.stringify(search)}`);
  }

  if (found.multiple) {
    return {
      success: false,
      error: 'multiple_matches',
      message: 'Multiple contacts match. Please be more specific.',
      matches: found.matches.map(m => ({
        name: m.fullName,
        email: m.email || '(no email)',
        id: m.uid
      }))
    };
  }

  // Parse existing vCard and merge updates
  const existingData = found.vcard.data;

  // Build merged contact from existing + updates
  const merged = { ...parseVCardBasic(existingData), ...updates };
  const vCardString = buildVCard(merged);

  const result = await client.updateVCard({
    vCard: {
      url: found.vcard.url,
      data: vCardString,
      etag: found.vcard.etag,
    },
  });

  if (!result.ok) {
    throw new Error(`Failed to update contact: ${result.statusText}`);
  }

  return {
    success: true,
    message: `Updated contact: ${found.fullName}`
  };
}

// Delete a contact
async function deleteContact(search) {
  const client = await getClient();
  const addressBooks = await client.fetchAddressBooks();

  if (!addressBooks || addressBooks.length === 0) {
    throw new Error('No address books found');
  }

  const found = await findVCard(client, addressBooks[0], search);

  if (!found) {
    throw new Error(`No contact found matching: ${JSON.stringify(search)}`);
  }

  if (found.multiple) {
    return {
      success: false,
      error: 'multiple_matches',
      message: 'Multiple contacts match. Please be more specific.',
      matches: found.matches.map(m => ({
        name: m.fullName,
        email: m.email || '(no email)',
        id: m.uid
      }))
    };
  }

  const result = await client.deleteVCard({
    vCard: {
      url: found.vcard.url,
      etag: found.vcard.etag,
    },
  });

  if (!result.ok) {
    throw new Error(`Failed to delete contact: ${result.statusText}`);
  }

  return {
    success: true,
    message: `Deleted contact: ${found.fullName}`
  };
}

// Basic vCard parser for merging
function parseVCardBasic(vCardText) {
  const contact = {};
  const lines = vCardText.split(/\r?\n/);

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;

    const key = line.substring(0, colonIndex);
    const value = line.substring(colonIndex + 1);

    if (key === 'UID') contact.id = value.trim();
    else if (key.startsWith('FN')) contact.full_name = value.trim();
    else if (key.startsWith('NICKNAME')) contact.nickname = value.trim();
    else if (key.startsWith('NOTE')) contact.notes = value.trim().replace(/\\n/g, '\n');
    else if (key === 'N' || key.startsWith('N;')) {
      const parts = value.split(';');
      contact.last_name = parts[0]?.trim() || '';
      contact.first_name = parts[1]?.trim() || '';
    }
    else if (key.startsWith('EMAIL')) contact.primary_email = value.trim();
    else if (key.startsWith('TEL')) contact.primary_phone = value.trim();
    else if (key.startsWith('ORG')) contact.organization = value.trim();
    else if (key.startsWith('TITLE')) contact.job_title = value.trim();
    else if (key.startsWith('BDAY')) contact.birthday = value.trim();
  }

  return contact;
}

// Main execution
async function main() {
  try {
    let result;

    switch (action) {
      case 'create':
        // entry contains the contact data directly
        result = await createContact(entry);
        break;
      case 'update':
        // entry contains { search, updates }
        result = await updateContact(entry.search, entry.updates);
        break;
      case 'delete':
        // entry contains { search }
        result = await deleteContact(entry.search);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    console.log(JSON.stringify(result));

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
}

main();

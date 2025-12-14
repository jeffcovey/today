#!/usr/bin/env node

// Read conversations from Front using the Core API
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries array
//
// Requires: FRONT_API_TOKEN environment variable

const API_BASE = 'https://api2.frontapp.com';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const inboxIds = config.inbox_ids ? config.inbox_ids.split(',').map(s => s.trim()) : [];
const assigneeEmail = config.assignee || '';
const includeArchived = config.include_archived === true || config.include_archived === 'true';
const limit = config.limit || 100;

const apiToken = process.env.FRONT_API_TOKEN;

if (!apiToken) {
  console.error(JSON.stringify({
    error: 'FRONT_API_TOKEN environment variable is required'
  }));
  process.exit(1);
}

// Check for incremental sync
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

// Cache for teammate ID lookup
let assigneeTeammateId = null;

async function fetchFromFront(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Front API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function lookupTeammateId(email) {
  const data = await fetchFromFront('/teammates');
  const teammates = data._results || [];
  const teammate = teammates.find(t => t.email === email);
  return teammate?.id || null;
}

async function fetchConversations() {
  let allConversations = [];

  // Build search query
  let searchParts = [];

  // Status filter
  if (!includeArchived) {
    searchParts.push('is:open');
  }

  // Assignee filter - need to look up teammate ID from email
  if (assigneeEmail) {
    assigneeTeammateId = await lookupTeammateId(assigneeEmail);
    if (assigneeTeammateId) {
      searchParts.push(`assignee:${assigneeTeammateId}`);
    } else {
      console.error(JSON.stringify({
        error: `Assignee not found: ${assigneeEmail}`
      }));
      process.exit(1);
    }
  }

  // Incremental sync - use after: with Unix timestamp
  if (lastSyncTime) {
    const timestamp = Math.floor(new Date(lastSyncTime).getTime() / 1000);
    // Go back one day to be safe (like github-issues)
    const safeTimestamp = timestamp - (24 * 60 * 60);
    searchParts.push(`after:${safeTimestamp}`);
  }

  const searchQuery = searchParts.join(' ');

  // If we have specific inbox IDs, fetch from each
  if (inboxIds.length > 0) {
    for (const inboxId of inboxIds) {
      const conversations = await fetchInboxConversations(inboxId, searchQuery);
      allConversations.push(...conversations);
    }
  } else {
    // Fetch all conversations using search
    const conversations = await fetchAllConversations(searchQuery);
    allConversations = conversations;
  }

  // Limit results
  return allConversations.slice(0, limit);
}

async function fetchInboxConversations(inboxId, searchQuery) {
  const conversations = [];
  let endpoint = `/inboxes/${inboxId}/conversations`;

  // Add search query if present
  if (searchQuery) {
    endpoint = `/conversations/search/${encodeURIComponent(searchQuery)}`;
  }

  let pageCount = 0;
  const maxPages = 10; // Safety limit

  while (endpoint && pageCount < maxPages && conversations.length < limit) {
    const data = await fetchFromFront(endpoint);

    if (data._results) {
      conversations.push(...data._results);
    }

    // Check for next page
    endpoint = data._pagination?._next || null;
    pageCount++;
  }

  return conversations;
}

async function fetchAllConversations(searchQuery) {
  const conversations = [];
  let endpoint;

  if (searchQuery) {
    endpoint = `/conversations/search/${encodeURIComponent(searchQuery)}`;
  } else {
    endpoint = '/conversations';
  }

  let pageCount = 0;
  const maxPages = 10; // Safety limit

  while (endpoint && pageCount < maxPages && conversations.length < limit) {
    const data = await fetchFromFront(endpoint);

    if (data._results) {
      conversations.push(...data._results);
    }

    // Check for next page
    endpoint = data._pagination?._next || null;
    pageCount++;
  }

  return conversations;
}

async function fetchFirstMessage(conversationId) {
  try {
    // Get the oldest message (last in reverse chronological list)
    const data = await fetchFromFront(`/conversations/${conversationId}/messages`);
    const messages = data._results || [];
    // Messages are newest first, so get the last one for the original message
    const firstMessage = messages[messages.length - 1];
    if (firstMessage) {
      const from = firstMessage.author?.email || firstMessage.recipients?.find(r => r.role === 'from')?.handle || null;
      let text = firstMessage.text || firstMessage.blurb || null;

      // Build body with "From:" header and truncated content
      let body = null;
      if (from || text) {
        const parts = [];
        if (from) {
          parts.push(`From: ${from}`);
        }
        if (text) {
          // Truncate to first 500 chars, cut at word boundary
          const maxLen = 500;
          if (text.length > maxLen) {
            const truncated = text.substring(0, maxLen);
            const lastSpace = truncated.lastIndexOf(' ');
            text = (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
          }
          parts.push(text);
        }
        body = parts.join('\n\n');
      }

      return { body, from };
    }
  } catch (e) {
    // Ignore errors fetching messages
  }
  return { body: null, from: null };
}

async function transformConversation(conv) {
  // Build metadata object
  const metadata = {};

  if (conv.assignee) {
    metadata.assignee = conv.assignee.email || conv.assignee.username;
  }

  if (conv.tags && conv.tags.length > 0) {
    metadata.tags = conv.tags.map(t => t.name);
  }

  if (conv.recipient) {
    metadata.recipient = conv.recipient.handle;
  }

  if (conv.status_category) {
    metadata.status_category = conv.status_category;
  }

  if (conv.last_message) {
    metadata.last_message_at = conv.last_message.created_at;
  }

  // Fetch the first message to get body content
  const firstMessage = await fetchFirstMessage(conv.id);

  // Map Front status to open/closed
  // Front statuses: open, archived, deleted, spam
  // status_category: resolved, open, etc.
  let state = 'open';
  if (conv.status === 'archived' || conv.status_category === 'resolved') {
    state = 'closed';
  }

  // Build URL from conversation ID
  const url = `https://app.frontapp.com/open/${conv.id}`;

  // Convert Unix timestamp to ISO string
  const openedAt = conv.created_at
    ? new Date(conv.created_at * 1000).toISOString()
    : new Date().toISOString();

  return {
    id: conv.id,
    title: conv.subject || '(No subject)',
    state,
    opened_at: openedAt,
    url,
    body: firstMessage.body,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  };
}

// Main execution
try {
  const conversations = await fetchConversations();
  const entries = await Promise.all(conversations.map(transformConversation));

  const isIncremental = !!lastSyncTime;

  console.log(JSON.stringify({
    entries,
    total: entries.length,
    incremental: isIncremental
  }));
} catch (error) {
  console.error(JSON.stringify({
    error: `Failed to fetch conversations: ${error.message}`
  }));
  process.exit(1);
}

/**
 * Reply forms for role blocks on the web view of today's daily plan.
 *
 * The rendered plan keeps each block's ROLE marker comments, so the web
 * server calls injectRoleReplyForms() on every page view (after the HTML
 * cache, so a page cached yesterday doesn't keep its forms today) and
 * saveRoleReply() when a form is sent. Both do nothing unless the roles
 * plugin is enabled.
 */

import path from 'path';
import { ROLE_NAME_RE } from '../../src/diary-role-blocks.js';
import { appendRoleReply, defaultTitle, rolesPluginEnabled } from './block-writer.js';
import { todayPlanRelativePath } from './plan-file.js';

export const ROLE_REPLY_ENDPOINT = '/roles/reply';

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

// The block's display name from its rendered "## 🤖 Title" heading. The
// heading text is already HTML-escaped by the renderer; decode the few
// entities it uses so escapeHtml doesn't double them.
function blockTitle(blockHtml, role) {
  const heading = blockHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (!heading) {
    return defaultTitle(role);
  }
  const text = heading[1]
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/🤖/g, '')
    .trim();
  return text || defaultTitle(role);
}

export function roleReplyFormHtml(role, title, relativePath) {
  const id = `role-reply-${role}`;
  const name = escapeHtml(title);
  return `<details class="task-section role-reply">
<summary>Reply to ${name}</summary>
<form class="role-reply-form" data-role="${role}" data-file="${escapeHtml(relativePath)}">
<label for="${id}" class="form-label">Your reply to ${name}</label>
<textarea id="${id}" name="text" class="form-control" rows="4" required aria-describedby="${id}-help"></textarea>
<div id="${id}-help" class="form-text">Markdown works. Saved as the last item here, starting with "-&gt; ${role}:". The agent reads it on its next run.</div>
<div class="d-flex align-items-center gap-2 mt-2">
<button type="submit" class="btn btn-primary btn-sm">Send reply</button>
<span class="role-reply-status small" role="status" aria-live="polite"></span>
</div>
</form>
</details>
`;
}

/**
 * Add a reply form before each role block's END marker in rendered HTML,
 * when the page is today's plan and the roles plugin is enabled.
 */
export function injectRoleReplyForms(html, relativePath, { now = new Date(), enabled = rolesPluginEnabled } = {}) {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized !== todayPlanRelativePath(now) || !html.includes('<!-- ROLE:') || !enabled()) {
    return html;
  }
  return html.replace(/<!-- ROLE:([a-z0-9-]+):END -->/g, (marker, role, offset) => {
    if (!ROLE_NAME_RE.test(role)) {
      return marker;
    }
    const startIndex = html.lastIndexOf(`<!-- ROLE:${role}:START -->`, offset);
    const blockHtml = startIndex === -1 ? '' : html.slice(startIndex, offset);
    return roleReplyFormHtml(role, blockTitle(blockHtml, role), normalized) + marker;
  });
}

/**
 * Save a reply from the web form. Only today's plan takes replies: the
 * agents read today's file, so a form left open past midnight is refused
 * rather than written somewhere nobody will read it.
 *
 * Returns { status, body } for the HTTP response.
 */
export function saveRoleReply(vaultPath, relativePath, role, text, { now = new Date(), enabled = rolesPluginEnabled } = {}) {
  if (!enabled()) {
    return { status: 404, body: { error: 'The roles plugin is not enabled' } };
  }
  const normalized = normalizeRelativePath(relativePath || '');
  if (normalized !== todayPlanRelativePath(now)) {
    return { status: 409, body: { error: "This isn't today's plan any more. Reload the page and reply there." } };
  }
  if (typeof role !== 'string' || typeof text !== 'string') {
    return { status: 400, body: { error: 'role and text are required' } };
  }

  const result = appendRoleReply(path.join(vaultPath, normalized), role, text);
  if (result.ok) {
    return { status: 200, body: { success: true, reply: result.reply } };
  }
  const status = { invalid: 400, missing: 404, conflict: 409 }[result.code] || 500;
  return { status, body: { error: result.error } };
}

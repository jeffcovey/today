/**
 * Lay out ROLE blocks as cards on the web view of a daily plan.
 *
 * The web server calls roleBlocksToCards() on a page's Markdown before
 * rendering it. Each block becomes a card: a header with the role's name,
 * its latest declared status and when it last reported; the latest report
 * open, with the replies and dispatch notes that led to it; earlier entries
 * folded away; the user's replies shown as "You" bubbles. The Markdown
 * inside is left as written, so checkboxes, callouts and links render as
 * they do everywhere else. The file itself is never changed.
 *
 * Cards are HTML blocks wrapped around Markdown: each wrapper tag sits on
 * its own line with blank lines around the Markdown, which CommonMark
 * renders as Markdown inside the HTML.
 */

import { ROLE_NAME_RE } from '../../src/diary-role-blocks.js';

const BLOCK_RE = /<!-- ROLE:([a-z0-9-]+):START -->\n?([\s\S]*?)<!-- ROLE:\1:END -->/g;
const ENTRY_HEADING_RE = /^### (\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
const REPLY_RE = /^(?:->|→)\s*([a-z0-9][a-z0-9-]*)\s*:\s?(.*)$/;
const STATUS_RE = /^\*\*Status:\*\*\s*(.+?)\s*$/;
const OPEN_CHECKBOX_RE = /^\s*(?:>\s*)*- \[ \] /;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

const STATUS_PILLS = {
  ok: { label: 'OK', tone: 'ok' },
  quiet: { label: 'Quiet', tone: 'quiet' },
  blocked: { label: 'Blocked', tone: 'attn' },
  'needs attention': { label: 'Needs attention', tone: 'attn' }
};

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function titleCase(role) {
  return role.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Split a block's content (after its "## 🤖 Title" heading) into segments:
 * entries (a "### HH:MM" heading and what follows it) and replies (a line
 * starting "-> role:" addressed to one of the page's roles, running until
 * the next entry or reply).
 */
export function parseRoleBlock(content, knownRoles) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let title = null;
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^## /.test(lines[0])) {
    title = lines.shift().replace(/^## /, '').replace(/🤖/g, '').trim();
  }

  const segments = [];
  const openItems = [];
  let current = null;
  let fence = null;
  for (const line of lines) {
    const fenceLine = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    let insideFence = Boolean(fence);
    if (fence) {
      const closingFence = fenceLine.match(FENCE_CLOSE_RE);
      if (closingFence && closingFence[1][0] === fence.character && closingFence[1].length >= fence.length) {
        fence = null;
      }
    } else {
      const openingFence = fenceLine.match(FENCE_OPEN_RE);
      if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
        fence = { character: openingFence[1][0], length: openingFence[1].length };
        insideFence = true;
      }
    }
    const heading = !insideFence && line.match(ENTRY_HEADING_RE);
    const reply = !insideFence && line.match(REPLY_RE);
    if (heading) {
      current = { kind: 'entry', heading: heading[1], lines: [] };
      segments.push(current);
    } else if (reply && knownRoles.has(reply[1])) {
      current = { kind: 'reply', to: reply[1], lines: reply[2] ? [reply[2]] : [] };
      segments.push(current);
    } else {
      if (!current) {
        if (!line.trim()) continue;
        current = { kind: 'entry', heading: null, lines: [] };
        segments.push(current);
      }
      if (!insideFence && current.kind === 'entry') {
        const status = line.match(STATUS_RE);
        if (status) {
          current.status = status[1];
          continue;
        }
        if (isOpenCheckbox(line)) {
          openItems.push(line);
        }
      }
      current.lines.push(line);
    }
  }

  for (const segment of segments) {
    while (segment.lines.length && !segment.lines[segment.lines.length - 1].trim()) segment.lines.pop();
    while (segment.lines.length && !segment.lines[0].trim()) segment.lines.shift();
    if (segment.kind !== 'entry') continue;
    // A dispatch note is an entry that holds nothing but an [!abstract] callout.
    const body = segment.lines.filter(line => line.trim());
    segment.dispatch = body.length > 0 && /^>\s*\[!abstract\]/i.test(body[0]) && body.every(line => /^>/.test(line));
  }

  return { title, segments, openItems };
}

// The renderer has already turned "- [-]" into "- [ ]" tagged data-cancelled.
function isOpenCheckbox(line) {
  return OPEN_CHECKBOX_RE.test(line) && !/data-cancelled="true"/.test(line);
}

/**
 * Which segments stay open: the latest report, plus the replies and
 * dispatch notes since the report before it (what prompted it), plus
 * anything after it. The rest is "earlier".
 */
export function splitLatest(segments) {
  let last = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'entry' && !segments[i].dispatch) {
      last = i;
      break;
    }
  }
  if (last === -1) {
    return { earlier: [], latest: segments };
  }
  let start = last;
  while (start > 0 && !(segments[start - 1].kind === 'entry' && !segments[start - 1].dispatch)) {
    start--;
  }
  return { earlier: segments.slice(0, start), latest: segments.slice(start) };
}

function statusPill(segments) {
  let status = null;
  for (const segment of segments) {
    if (segment.status) status = segment.status;
  }
  if (!status) return null;
  return STATUS_PILLS[status.toLowerCase()] || { label: status, tone: 'quiet' };
}

function renderSegment(segment, role, titles) {
  const body = segment.lines.join('\n');
  if (segment.kind === 'reply') {
    const to = segment.to === role ? '' : ` → ${escapeHtml(titles.get(segment.to) || titleCase(segment.to))}`;
    return `<div class="role-you">\n<span class="role-you-label">You${to}</span>\n\n${body}\n\n</div>`;
  }
  if (segment.dispatch) {
    // One quiet line: the time moves into the callout's title.
    const time = segment.heading ? `${segment.heading} · ` : '';
    const lines = segment.lines.filter(line => line.trim());
    lines[0] = lines[0].replace(/^(>\s*\[!abstract\][-+]?\s*)/i, `$1${time}`);
    return `<div class="role-entry role-dispatch">\n\n${lines.join('\n')}\n\n</div>`;
  }
  const heading = segment.heading ? `### ${segment.heading}\n\n` : '';
  return `<div class="role-entry">\n\n${heading}${body}\n\n</div>`;
}

function earlierSummary(earlier) {
  const times = earlier.filter(s => s.kind === 'entry' && s.heading).map(s => s.heading);
  const open = earlier.reduce((count, s) => count + s.lines.filter(isOpenCheckbox).length, 0);
  const parts = ['Earlier'];
  if (times.length) parts.push(escapeHtml(times.join(', ')));
  if (open) parts.push(`${open} open item${open === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function renderCard(role, parsed, titles) {
  const title = parsed.title || titleCase(role);
  const { earlier, latest } = splitLatest(parsed.segments);
  const pill = statusPill(parsed.segments);
  const lastEntry = [...parsed.segments].reverse().find(s => s.kind === 'entry' && !s.dispatch && s.heading && TIME_RE.test(s.heading));

  const head = [`## 🤖 ${title}`];
  if (pill) head.push(`<span class="role-pill role-pill-${pill.tone}">${escapeHtml(pill.label)}</span>`);
  if (lastEntry) head.push(`<span class="role-updated">Updated ${escapeHtml(lastEntry.heading)}</span>`);

  const body = latest.map(s => renderSegment(s, role, titles));
  if (earlier.length) {
    body.push([
      '<details class="role-earlier">',
      `<summary>${earlierSummary(earlier)}</summary>`,
      '',
      earlier.map(s => renderSegment(s, role, titles)).join('\n\n'),
      '',
      '</details>'
    ].join('\n'));
  }

  const cardClass = pill && pill.tone === 'attn' ? 'role-card role-card-attn' : 'role-card';
  return [
    `<!-- ROLE:${role}:START -->`,
    `<div class="${cardClass}" id="role-${role}">`,
    '<div class="role-card-head">',
    '',
    head.join('\n\n'),
    '',
    '</div>',
    '<div class="role-card-body">',
    '',
    body.join('\n\n'),
    '',
    '</div>',
    '<div class="role-card-foot">',
    '',
    `<!-- ROLE:${role}:END -->`,
    '',
    '</div>',
    '</div>'
  ].join('\n');
}

/**
 * "Needs you": every still-open checkbox from every role, in one list at
 * the top of the staff section. Each item is the role's own task line
 * (so toggling it updates the file like any checkbox), without the
 * blockquote prefix or the "→ Name:" address, followed by the role's name.
 */
export function renderNeedsYou(parsedBlocks, titles) {
  const items = [];
  for (const [role, parsed] of parsedBlocks) {
    for (const line of parsed.openItems) {
      const text = line
        .replace(/^\s*(?:>\s*)*- \[ \] /, '')
        .replace(/^→\s*[^:]+:\s*/, '');
      items.push(`- [ ] ${text} <span class="role-needs-who">${escapeHtml(titles.get(role))}</span>`);
    }
  }
  if (items.length === 0) {
    return '';
  }
  return [
    '<section class="role-needs" aria-labelledby="role-needs-title">',
    `<div class="role-needs-title" id="role-needs-title">Needs you · <span class="role-needs-count">${items.length} open</span></div>`,
    '',
    items.join('\n'),
    '',
    '</section>',
    ''
  ].join('\n');
}

/**
 * Replace each ROLE block in a page's Markdown with its card. A heading
 * line ("Staff · N roles · latest report HH:MM") and the "Needs you" list
 * introduce the first card.
 * Markdown without ROLE blocks is returned unchanged.
 */
export function roleBlocksToCards(markdown) {
  if (!markdown.includes('<!-- ROLE:')) {
    return markdown;
  }

  const blocks = [...markdown.matchAll(BLOCK_RE)].filter(m => ROLE_NAME_RE.test(m[1]));
  if (blocks.length === 0) {
    return markdown;
  }
  const knownRoles = new Set(blocks.map(m => m[1]));
  const parsedBlocks = new Map(blocks.map(m => [m[1], parseRoleBlock(m[2], knownRoles)]));
  const titles = new Map([...parsedBlocks].map(([role, parsed]) => [role, parsed.title || titleCase(role)]));

  const times = [...parsedBlocks.values()]
    .flatMap(parsed => parsed.segments)
    .filter(s => s.kind === 'entry' && !s.dispatch && s.heading && TIME_RE.test(s.heading))
    .map(s => s.heading.padStart(5, '0'))
    .sort();
  const staffMeta = [`${blocks.length} role${blocks.length === 1 ? '' : 's'}`];
  if (times.length) staffMeta.push(`latest report ${times[times.length - 1]}`);
  const staffHead = `<div class="role-staff-head" role="heading" aria-level="2"><span class="role-staff-title">Staff</span> <span class="role-staff-meta">${staffMeta.join(' · ')}</span></div>\n\n` +
    renderNeedsYou(parsedBlocks, titles) + '\n';

  let first = true;
  return markdown.replace(BLOCK_RE, (match, role) => {
    if (!parsedBlocks.has(role)) {
      return match;
    }
    const card = renderCard(role, parsedBlocks.get(role), titles);
    const prefix = first ? staffHead : '';
    first = false;
    return `${prefix}${card}`;
  });
}

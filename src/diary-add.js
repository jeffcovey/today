/**
 * Add an entry to a day's markdown diary file, the way `bin/diary add` does:
 * gratitude as a bullet under "## I'm grateful for...", the others as a
 * "### HH:MM" block under "## Progress", "## Concern" or "## Journal".
 *
 * The markdown-diary plugin has no write command, so this is the write path
 * for tools that add entries (the MCP add_diary_entry tool). Two things
 * differ from the inline copy in bin/diary, both to keep existing content
 * intact: a section is found by its whole heading line (so "## Concern" is
 * not found inside "## Concerns"), headings inside ROLE/TODAY marker blocks
 * are skipped, and a section ends at a marker comment as well as at the next
 * "## " heading, so an entry is never written into a role's block.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import { writeFileAtomicCAS } from './fs-atomic.js';
import { withFileLocks } from './file-lock.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Entry types `bin/diary add` accepts. Role entries are written by the roles plugin. */
export const DIARY_ADD_TYPES = ['gratitude', 'progress', 'concern', 'journal'];

export const DEFAULT_DIARY_DIRECTORY = 'vault/diary';

/** The section heading for each type, and the headings the reader accepts as the same section. */
const SECTIONS = {
  gratitude: { heading: "I'm grateful for...", match: /^## (?:I'm grateful for(?:\.\.\.)?|Gratitude)[ \t]*$/im },
  progress: { heading: 'Progress', match: /^## Progress[ \t]*$/im },
  concern: { heading: 'Concern', match: /^## Concerns?[ \t]*$/im },
  journal: { heading: 'Journal', match: /^## Journal[ \t]*$/im },
};

const SECTION_END = /\n(?:## |<!--\s*(?:ROLE|TODAY):)/;

// The heading plugins/markdown-diary/read.js treats as an entry's time. Once a
// section has one, the reader keeps only text under such headings.
const TIMESTAMP_HEADING = /^### \d{1,2}:\d{2}(?::\d{2})?\s*$/m;

/**
 * Absolute diary directory for a markdown-diary source's config, resolved the
 * way plugins/markdown-diary/read.js resolves it: path.join onto the project
 * root, even for a directory that is already absolute. Resolving it any other
 * way would write entries where the reader never looks.
 */
export function resolveDiaryDirectory(sourceConfig = {}, projectRoot = PROJECT_ROOT) {
  const dir = sourceConfig.diary_directory || DEFAULT_DIARY_DIRECTORY;
  return path.join(projectRoot, dir);
}

/** Thrown by addDiaryEntry when another write holds the day's file lock. */
export class DiaryBusyError extends Error {}

// ROLE and TODAY marker blocks belong to the roles plugin and the diary
// reader; a heading inside one is part of that block, not the user's section.
const MARKER_BLOCK = /<!--\s*(ROLE|TODAY):([^:\s]+):START\s*-->[\s\S]*?<!--\s*\1:\2:END\s*-->/g;

function markerSpans(doc) {
  return [...doc.matchAll(MARKER_BLOCK)].map(m => [m.index, m.index + m[0].length]);
}

/** The first heading line matching `re` that is not inside a marker block. */
function findSectionOutsideMarkers(doc, re) {
  const spans = markerSpans(doc);
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of doc.matchAll(global)) {
    if (!spans.some(([start, end]) => m.index >= start && m.index < end)) return m;
  }
  return null;
}

/**
 * Insert one entry into diary file content and return the new content.
 * @returns {{content: string, markdown: string}}
 */
export function insertDiaryEntry(content, { type, text, date, time }) {
  const section = SECTIONS[type];
  if (!section) throw new Error(`Invalid type "${type}". Use: ${DIARY_ADD_TYPES.join(', ')}`);

  let doc = content || `---\ndate: ${date}\n---\n\n`;
  let match = findSectionOutsideMarkers(doc, section.match);
  if (!match) {
    doc = `${doc.trimEnd()}\n\n## ${section.heading}\n`;
    match = findSectionOutsideMarkers(doc, section.match);
  }

  const insertPoint = match.index + match[0].length;
  const before = doc.slice(0, insertPoint);
  const after = doc.slice(insertPoint);
  const end = after.match(SECTION_END);
  const sectionEnd = end ? end.index : after.length;
  const sectionContent = after.slice(0, sectionEnd);
  const rest = after.slice(sectionEnd);

  const markdown = type === 'gratitude' ? `- ${text}` : `### ${time}\n${text}`;
  const joiner = type === 'gratitude' ? '\n' : '\n\n';
  // The reader reads a section with no timestamp headings as one entry at
  // midnight, and ignores untimed text once a heading exists. Give existing
  // untimed text that midnight heading so the new entry doesn't hide it.
  let kept = sectionContent.trimEnd();
  if (type !== 'gratitude' && kept.trim() && !TIMESTAMP_HEADING.test(kept)) {
    kept = `\n\n### 00:00\n${kept.trim()}`;
  }
  // `rest` starts with the newline before the next heading or marker, which
  // leaves one blank line between the entry and what follows.
  return { content: `${before}${kept}${joiner}${markdown}\n${rest}`, markdown };
}

/**
 * Add an entry to the day's diary file in `diaryDir`.
 *
 * @param {object} options
 * @param {string} options.type - one of DIARY_ADD_TYPES
 * @param {string} options.text
 * @param {string} options.diaryDir - absolute directory
 * @param {string} options.timezone - IANA zone for the day and the time
 * @param {Date} [options.now]
 * @returns {{file: string, date: string, time: string, type: string, markdown: string, created: boolean}}
 */
export function addDiaryEntry({ type, text, diaryDir, timezone, now = new Date() }) {
  if (!DIARY_ADD_TYPES.includes(type)) {
    throw new Error(`Invalid type "${type}". Use: ${DIARY_ADD_TYPES.join(', ')}`);
  }
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('Entry text is empty');

  const zoned = new TZDate(now.getTime(), timezone);
  const date = format(zoned, 'yyyy-MM-dd');
  const time = format(zoned, 'HH:mm');
  const file = path.join(diaryDir, `${date}.md`);
  fs.mkdirSync(diaryDir, { recursive: true });

  // The CAS check and the rename are separate steps, so two processes adding
  // entries at once could both pass the check and one entry would be lost.
  // The lock serialises writers that use it; the CAS retry still covers
  // writers that don't (an editor, a sync).
  try {
    return withFileLocks([file], () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        let original = null;
        try {
          original = fs.readFileSync(file, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const { content, markdown } = insertDiaryEntry(original, { type, text: body, date, time });
        const { conflict } = writeFileAtomicCAS(file, content, original);
        if (!conflict) return { file, date, time, type, markdown, created: original === null };
      }
      throw new Error(`${file} kept changing while the entry was being added; nothing was written`);
    });
  } catch (error) {
    if (/Timed out acquiring file lock/.test(error.message)) {
      throw new DiaryBusyError(`Another write to ${path.basename(file)} is in progress; nothing was changed. Try again in a moment.`);
    }
    throw error;
  }
}

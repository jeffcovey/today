import * as yaml from 'js-yaml';
import { load as loadHtml } from 'cheerio';
import { formatDate } from './date-utils.js';

function resolveDataviewPath(properties, propertyPath) {
  if (!properties || !propertyPath) return undefined;

  let value = properties;
  for (const segment of propertyPath.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return undefined;
    }
    value = value[segment];
  }

  return value;
}

function formatInlineDataviewValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;

  if (Array.isArray(value)) {
    if (value.some(item => item !== null && typeof item === 'object')) {
      return fallback;
    }
    return value.join(', ');
  }

  if (value instanceof Date) {
    return formatDate(value);
  }

  if (typeof value === 'object') {
    return fallback;
  }

  return String(value);
}

function parseTableOfContentsOptions(config) {
  const options = { minLevel: 2, maxLevel: 6 };

  if (!config.trim()) return options;

  try {
    const parsed = yaml.load(config);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return options;
    }

    if (Number.isInteger(parsed.minLevel)) {
      options.minLevel = Math.min(6, Math.max(1, parsed.minLevel));
    }
    if (Number.isInteger(parsed.maxLevel)) {
      options.maxLevel = Math.min(6, Math.max(1, parsed.maxLevel));
    }
    if (options.minLevel > options.maxLevel) {
      [options.minLevel, options.maxLevel] = [options.maxLevel, options.minLevel];
    }
  } catch {
    return options;
  }

  return options;
}

function generateTableOfContentsHtml(headings, options = {}) {
  const minLevel = options.minLevel ?? 2;
  const maxLevel = options.maxLevel ?? 6;
  const tocHeadings = headings.filter(h => h.level >= minLevel && h.level <= maxLevel);

  if (tocHeadings.length === 0) return '';

  let tocHtml = '';
  tocHtml += '<details class="toc-header">\n';
  tocHtml += '<summary class="text-muted small" style="cursor: pointer; user-select: none;"><i class="fas fa-list me-1"></i>Table of Contents</summary>\n';
  tocHtml += '<div class="toc-links mt-1">\n';
  tocHtml += '<ul class="list-unstyled small mb-0">\n';

  tocHeadings.forEach(heading => {
    const indent = (heading.level - minLevel) * 15;
    const escapedId = escapeHtml(String(heading.id ?? ''));
    const linkText = String(heading.text ?? '');
    tocHtml += `<li style="margin-left: ${indent}px; margin-bottom: 0.15rem; line-height: 1.3;">`;
    tocHtml += `<a href="#${escapedId}">`;
    tocHtml += linkText;
    tocHtml += '</a></li>\n';
  });

  tocHtml += '</ul>\n';
  tocHtml += '</div>\n';
  tocHtml += '</details>\n';

  return tocHtml;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(text) {
  const $ = loadHtml(`<textarea>${text}</textarea>`);
  return $('textarea').text();
}

function renderTableOfContentsCodeBlocks(htmlContent, headings) {
  return htmlContent.replace(
    /<pre[^>]*><code[^>]*class="[^"]*language-table-of-contents[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (match, config) => generateTableOfContentsHtml(headings, parseTableOfContentsOptions(decodeHtmlEntities(config)))
  );
}

export {
  formatInlineDataviewValue,
  generateTableOfContentsHtml,
  parseTableOfContentsOptions,
  renderTableOfContentsCodeBlocks,
  resolveDataviewPath,
};

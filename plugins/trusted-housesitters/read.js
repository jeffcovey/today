#!/usr/bin/env node

/**
 * TrustedHousesitters Plugin - Read Command
 *
 * Scrapes housesitting listings from TrustedHousesitters.com using Puppeteer.
 * Applies configured filters and outputs entries for the database.
 * Optionally generates a browsable markdown file in the vault.
 */

import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { launchBrowser, createPage, loadCookies, isSessionValid } from './browser.js';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const sourceId = process.env.SOURCE_ID || 'trusted-housesitters/default';
const contextOnly = process.env.CONTEXT_ONLY === 'true';

// Credentials
const email = config.email;
const password = config.password;

// Filter settings
const availabilityWindows = config.availability_windows || [];
const blockedDates = config.blocked_dates || [];
const requireFullOverlap = config.require_full_overlap || false;
const minDurationDays = config.min_duration_days || 0;
const maxDurationDays = config.max_duration_days || 0;
const countries = config.countries || [];
const excludeCountries = config.exclude_countries || [];
const maxDogs = config.max_dogs ?? -1;
const maxCats = config.max_cats ?? -1;
const maxTotalPets = config.max_total_pets ?? -1;
const allowedPets = config.allowed_pets || [];
const excludedPets = config.excluded_pets || [];

// Output settings
const outputFile = config.output_file || 'vault/trusted-housesitters/current-listings.md';
const maxPages = config.max_pages || 20;

// Cache file for storing scraped data
const cacheDir = path.join(projectRoot, '.data', 'trusted-housesitters');
const cacheFile = path.join(cacheDir, 'listings.json');
const legacyImagesDir = path.join(cacheDir, 'images');
const vaultImagesDir = path.join(projectRoot, 'vault', 'trusted-housesitters', 'images');

/**
 * Parse date string like "12 Mar 2025" to Date object
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Parse date range like "12 Mar - 02 Apr 2025", "12 Mar 2025 - 02 Apr 2025",
 * or "Apr 09, 2026 - Apr 16, 2026 +" (US format with trailing +)
 */
function parseDateRange(dateRangeStr) {
  if (!dateRangeStr) return { start: null, end: null };

  // Strip trailing "+" (indicates flexible dates)
  const cleaned = dateRangeStr.replace(/\s*\+\s*$/, '').trim();

  const parts = cleaned.split(' - ');
  if (parts.length !== 2) return { start: null, end: null };

  let startStr = parts[0].trim();
  let endStr = parts[1].trim();

  // If start doesn't have a year, append the year from end
  if (!/\d{4}/.test(startStr)) {
    const yearMatch = endStr.match(/\d{4}/);
    if (yearMatch) {
      startStr += ' ' + yearMatch[0];
    }
  }

  return {
    start: parseDate(startStr),
    end: parseDate(endStr)
  };
}

/**
 * Parse location string like "Blanzay, France" or "Seattle, WA, US"
 */
function parseLocation(locationStr) {
  if (!locationStr) return { city: '', state: '', country: '' };

  const parts = locationStr.split(',').map(p => p.trim());

  if (parts.length === 1) {
    return { city: '', state: '', country: parts[0] };
  } else if (parts.length === 2) {
    return { city: parts[0], state: '', country: parts[1] };
  } else {
    return { city: parts[0], state: parts[1], country: parts[2] };
  }
}

/**
 * Calculate duration in days between two dates
 */
function getDurationDays(start, end) {
  if (!start || !end) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((end - start) / msPerDay);
}

/**
 * Check if a date range overlaps with an availability window
 */
function overlapsWithWindow(sitStart, sitEnd, window) {
  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);

  // Overlap if sit starts before window ends AND sit ends after window starts
  return sitStart <= windowEnd && sitEnd >= windowStart;
}

/**
 * Check if a date range fits entirely within an availability window
 */
function fitsWithinWindow(sitStart, sitEnd, window) {
  const windowStart = new Date(window.start);
  const windowEnd = new Date(window.end);

  return sitStart >= windowStart && sitEnd <= windowEnd;
}

/**
 * Check if a date range overlaps with any blocked dates
 */
function overlapsWithBlocked(sitStart, sitEnd, blocked) {
  for (const block of blocked) {
    const blockStart = new Date(block.start);
    const blockEnd = new Date(block.end);

    if (sitStart <= blockEnd && sitEnd >= blockStart) {
      return true;
    }
  }
  return false;
}

/**
 * Apply all filters to a listing
 */
function passesFilters(listing) {
  const sitStart = new Date(listing.start_date);
  const sitEnd = new Date(listing.end_date);
  const duration = listing.duration_days;
  const animals = listing.animals || {};

  // Skip if start date is in the past
  if (sitStart < new Date()) {
    return false;
  }

  // Availability window filter
  if (availabilityWindows.length > 0) {
    let matchesWindow = false;
    for (const window of availabilityWindows) {
      if (requireFullOverlap) {
        if (fitsWithinWindow(sitStart, sitEnd, window)) {
          matchesWindow = true;
          break;
        }
      } else {
        if (overlapsWithWindow(sitStart, sitEnd, window)) {
          matchesWindow = true;
          break;
        }
      }
    }
    if (!matchesWindow) return false;
  }

  // Blocked dates filter
  if (blockedDates.length > 0) {
    if (overlapsWithBlocked(sitStart, sitEnd, blockedDates)) {
      return false;
    }
  }

  // Duration filters
  if (minDurationDays > 0 && duration < minDurationDays) {
    return false;
  }
  if (maxDurationDays > 0 && duration > maxDurationDays) {
    return false;
  }

  // Country filters
  if (countries.length > 0) {
    if (!countries.includes(listing.country)) {
      return false;
    }
  }
  if (excludeCountries.length > 0) {
    if (excludeCountries.includes(listing.country)) {
      return false;
    }
  }

  // Pet filters
  const dogCount = animals.Dog || 0;
  const catCount = animals.Cat || 0;
  const totalPets = Object.values(animals).reduce((a, b) => a + b, 0);
  const petTypes = Object.keys(animals);

  if (maxDogs >= 0 && dogCount > maxDogs) {
    return false;
  }
  if (maxCats >= 0 && catCount > maxCats) {
    return false;
  }
  if (maxTotalPets >= 0 && totalPets > maxTotalPets) {
    return false;
  }

  if (allowedPets.length > 0) {
    for (const pet of petTypes) {
      if (!allowedPets.includes(pet)) {
        return false;
      }
    }
  }

  if (excludedPets.length > 0) {
    for (const pet of petTypes) {
      if (excludedPets.includes(pet)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Download an image and save locally
 */
async function downloadImage(url, listingId) {
  if (!url) return null;

  fs.mkdirSync(vaultImagesDir, { recursive: true });
  const localPath = path.join(vaultImagesDir, `${listingId}.jpg`);

  // Skip if already exists in vault
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Check legacy .data location and migrate if found (old files used slugified URLs as names)
  if (fs.existsSync(legacyImagesDir)) {
    const legacyFile = fs.readdirSync(legacyImagesDir).find(f => f.includes(`_${listingId}_`));
    if (legacyFile) {
      fs.copyFileSync(path.join(legacyImagesDir, legacyFile), localPath);
      return localPath;
    }
  }

  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Referer': 'https://www.trustedhousesitters.com/'
      }
    }, (response) => {
      if (response.statusCode === 200) {
        const file = fs.createWriteStream(localPath);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(localPath);
        });
      } else {
        resolve(null);
      }
    }).on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Extract listing ID from URL
 */
function getListingId(url) {
  // URL like https://www.trustedhousesitters.com/house-and-pet-sitting-assignments/united-kingdom/england/649629
  const match = url.match(/\/(\d+)(?:[/?]|$)/);
  return match ? match[1] : url.replace(/[^a-z0-9]/gi, '_');
}

/**
 * Scrape listings from TrustedHousesitters using Puppeteer
 */
async function scrapeListings() {
  console.error('Launching browser...');

  const browser = await launchBrowser();

  try {
    const page = await createPage(browser);

    // Load cookies for authentication
    const hasCookies = await loadCookies(page, sourceId);
    if (!hasCookies) {
      throw new Error('No saved session. Run: bin/plugins login trusted-housesitters');
    }

    // Navigate to listings (isSessionValid does this and checks for redirect)
    console.error('Checking session and navigating to listings...');
    const valid = await isSessionValid(page);
    if (!valid) {
      throw new Error('Session expired. Run: bin/plugins login trusted-housesitters');
    }

    // Sort by newest
    try {
      await page.waitForSelector('button', { timeout: 5000 });
      const sortButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.includes('Sort by'));
      });

      if (sortButton) {
        await sortButton.click();
        await new Promise(resolve => setTimeout(resolve, 2000));

        const newestOption = await page.$('label[for="checkButton_newest"]');
        if (newestOption) {
          await newestOption.click();
          await new Promise(resolve => setTimeout(resolve, 1000));

          const applyButton = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => b.textContent.includes('Apply'));
          });
          if (applyButton) {
            await applyButton.click();
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
    } catch (e) {
      console.error('Could not sort by newest, continuing with default order');
    }

    // Scrape pages
    const allListings = [];
    const allReviewingIds = [];
    let pageNum = 1;

    // Load existing cache for early pagination stop
    const cachedListings = loadCache();
    const cachedUrls = new Set(cachedListings.map(l => l.url));

    while (pageNum <= maxPages) {
      console.error(`Scraping page ${pageNum}...`);

      const html = await page.content();
      const $ = cheerio.load(html);

      // Debug: save HTML for inspection
      if (pageNum === 1) {
        const debugPath = path.join(cacheDir, 'debug-page.html');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(debugPath, html);
        console.error(`Saved debug HTML to ${debugPath}`);
      }

      // Extract reviewing status from embedded state data
      const reviewingIds = await page.evaluate(() => {
        const state = window.__INITIAL_STATE__;
        if (!state?.search?.listing) return [];
        const ids = [];
        for (const [listingId, listing] of Object.entries(state.search.listing)) {
          const assignments = listing.openAssignments || [];
          const allReviewing = assignments.length > 0 && assignments.every(a => a.isReviewing || a.isConfirmed);
          if (allReviewing) ids.push(listingId);
        }
        return ids;
      });
      const reviewingSet = new Set(reviewingIds);
      allReviewingIds.push(...reviewingIds);
      if (reviewingSet.size > 0) {
        console.error(`  ${reviewingSet.size} listings closed to new applicants on page ${pageNum}`);
      }

      const listingCards = $('div[data-testid="ListingCard__container"]');
      console.error(`Found ${listingCards.length} listing cards on page ${pageNum}`);

      if (listingCards.length === 0) {
        console.error('No listings found on page, stopping');
        break;
      }

      const pageListings = [];

      listingCards.each((_, card) => {
        const $card = $(card);

        const title = $card.find('h3[data-testid="ListingCard__title"]').text().trim();
        // Date is in a span inside the div following the title's parent div
        const dateRangeText = $card.find('h3[data-testid="ListingCard__title"]').closest('div').next('div').find('span').first().text().trim() ||
                             $card.find('span.sc-11tod73-8.sc-80wmlu-10').text().trim() ||
                             $card.find('[class*="DateRange"]').text().trim();
        const locationText = $card.find('span[data-testid="ListingCard__location"]').text().trim();
        const relativeUrl = $card.find('a').attr('href') || '';
        const url = relativeUrl ? `https://www.trustedhousesitters.com${relativeUrl.split('?')[0]}` : '';

        // Parse dates and location
        const { start, end } = parseDateRange(dateRangeText);
        const location = parseLocation(locationText);

        // Extract animals
        const animals = {};
        $card.find('ul[data-testid="animals-list"] li').each((_, animalEl) => {
          const $animal = $(animalEl);
          const countText = $animal.find('span[data-testid="Animal__count"]').text();
          const count = parseInt(countText) || 1;
          const animalName = $animal.find('svg title').text().trim();
          if (animalName) {
            animals[animalName.charAt(0).toUpperCase() + animalName.slice(1).toLowerCase()] = count;
          }
        });

        // Get image URL
        const imageUrl = $card.find('div[data-testid="ListingCard__image"] img').attr('src');

        if (title && url && start && end) {
          const listingId = getListingId(url);
          if (reviewingSet.has(listingId)) {
            console.error(`  Skipping "${title}" (closed to new applicants)`);
          } else {
            pageListings.push({
              id: listingId,
              title,
              url,
              start_date: start.toISOString().split('T')[0],
              end_date: end.toISOString().split('T')[0],
              duration_days: getDurationDays(start, end),
              city: location.city,
              state: location.state,
              country: location.country,
              animals,
              image_url: imageUrl,
              date_added: new Date().toISOString().split('T')[0]
            });
          }
        }
      });

      // Check for new listings on this page
      const newOnThisPage = pageListings.filter(l => !cachedUrls.has(l.url));
      console.error(`  ${newOnThisPage.length} new listings on page ${pageNum}`);

      allListings.push(...pageListings);

      if (newOnThisPage.length === 0) {
        console.error('All listings on this page already cached, stopping pagination');
        break;
      }

      // Check for next page
      const nextLink = $('a[aria-label="Go to next page"]');
      if (nextLink.length === 0) {
        console.error('No more pages');
        break;
      }

      const nextHref = nextLink.attr('href');
      if (!nextHref) break;

      await page.goto(`https://www.trustedhousesitters.com${nextHref}`, { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 2000));
      pageNum++;
    }

    console.error(`Scraped ${allListings.length} listings total`);
    return { listings: allListings, reviewingIds: allReviewingIds, page, browser };

  } catch (e) {
    await browser.close();
    throw e;
  }
}

// --- Shared markdown helpers ---

const countryCode = {
  'Afghanistan': 'AF', 'Albania': 'AL', 'Algeria': 'DZ', 'Argentina': 'AR',
  'Australia': 'AU', 'Austria': 'AT', 'Bahamas': 'BS', 'Barbados': 'BB',
  'Belgium': 'BE', 'Belize': 'BZ', 'Bermuda': 'BM', 'Bolivia': 'BO',
  'Bosnia and Herzegovina': 'BA', 'Brazil': 'BR', 'Bulgaria': 'BG',
  'Cambodia': 'KH', 'Canada': 'CA', 'Chile': 'CL', 'China': 'CN',
  'Colombia': 'CO', 'Costa Rica': 'CR', 'Croatia': 'HR', 'Cuba': 'CU',
  'Cyprus': 'CY', 'Czech Republic': 'CZ', 'Czechia': 'CZ',
  'Denmark': 'DK', 'Dominican Republic': 'DO', 'Ecuador': 'EC',
  'Egypt': 'EG', 'El Salvador': 'SV', 'Estonia': 'EE', 'Fiji': 'FJ',
  'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Ghana': 'GH',
  'Greece': 'GR', 'Grenada': 'GD', 'Guatemala': 'GT', 'Guernsey': 'GG',
  'Honduras': 'HN', 'Hong Kong': 'HK', 'Hungary': 'HU', 'Iceland': 'IS',
  'India': 'IN', 'Indonesia': 'ID', 'Ireland': 'IE', 'Isle of Man': 'IM',
  'Israel': 'IL', 'Italy': 'IT', 'Jamaica': 'JM', 'Japan': 'JP',
  'Jersey': 'JE', 'Jordan': 'JO', 'Kenya': 'KE', 'Latvia': 'LV',
  'Lithuania': 'LT', 'Luxembourg': 'LU', 'Malaysia': 'MY', 'Malta': 'MT',
  'Mauritius': 'MU', 'Mexico': 'MX', 'Monaco': 'MC', 'Montenegro': 'ME',
  'Morocco': 'MA', 'Nepal': 'NP', 'Netherlands': 'NL', 'New Zealand': 'NZ',
  'Nicaragua': 'NI', 'Nigeria': 'NG', 'Norway': 'NO', 'Oman': 'OM',
  'Pakistan': 'PK', 'Panama': 'PA', 'Paraguay': 'PY', 'Peru': 'PE',
  'Philippines': 'PH', 'Poland': 'PL', 'Portugal': 'PT', 'Puerto Rico': 'PR',
  'Romania': 'RO', 'Russia': 'RU', 'Saint Lucia': 'LC', 'Serbia': 'RS',
  'Singapore': 'SG', 'Slovakia': 'SK', 'Slovenia': 'SI', 'South Africa': 'ZA',
  'South Korea': 'KR', 'Spain': 'ES', 'Sri Lanka': 'LK', 'Sweden': 'SE',
  'Switzerland': 'CH', 'Taiwan': 'TW', 'Tanzania': 'TZ', 'Thailand': 'TH',
  'Trinidad and Tobago': 'TT', 'Tunisia': 'TN', 'Turkey': 'TR',
  'Turks and Caicos Islands': 'TC', 'US': 'US', 'USA': 'US',
  'United Kingdom': 'GB', 'UK': 'GB', 'United States': 'US',
  'Uruguay': 'UY', 'Venezuela': 'VE', 'Vietnam': 'VN', 'Zambia': 'ZM',
};

const petEmoji = {
  Dog: '🐶', Cat: '🐱', Horse: '🐴', Bird: '🐦',
  Fish: '🐟', Rabbit: '🐰', Reptile: '🦎', 'Small pet': '🐹'
};

function countryFlag(name) {
  const code = countryCode[name];
  if (!code) return '';
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

function renderListingCard(listing, lines, { imagesRelPath = 'images' } = {}) {
  const isNew = new Date(listing.date_added) >= oneDayAgo;
  const newBadge = isNew ? ' 🆕' : '';

  lines.push(`### ${listing.title}${newBadge}`);
  lines.push('');

  const imageFile = `${listing.id}.jpg`;
  const hasImage = fs.existsSync(path.join(vaultImagesDir, imageFile));
  if (hasImage) {
    lines.push(`<img src="${imagesRelPath}/${imageFile}" alt="${listing.title.replace(/"/g, '&quot;')}" width="280" align="right" style="margin-left: 16px; margin-bottom: 8px; border-radius: 8px;">`);
    lines.push('');
  }

  const startDate = new Date(listing.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const endDate = new Date(listing.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  lines.push(`**Dates:** ${startDate} - ${endDate} (${listing.duration_days} days)`);

  const locationParts = [listing.city, listing.state, listing.country].filter(Boolean);
  const locFlag = countryFlag(listing.country);
  lines.push(`**Location:** ${locationParts.join(', ')}${locFlag ? ' ' + locFlag : ''}`);

  if (Object.keys(listing.animals).length > 0) {
    const petStrings = Object.entries(listing.animals).map(([pet, count]) => {
      const emoji = petEmoji[pet] || '🐾';
      return `${count} ${pet.toLowerCase()}${count > 1 ? 's' : ''} ${emoji}`;
    });
    lines.push(`**Pets:** ${petStrings.join(', ')}`);
  }

  const daysAgo = Math.floor((Date.now() - new Date(listing.date_added).getTime()) / (24 * 60 * 60 * 1000));
  const postedLabel = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
  lines.push(`**Posted:** ${postedLabel}`);

  lines.push('');
  lines.push(`[View on TrustedHousesitters](${listing.url})`);
  lines.push('');
  if (hasImage) lines.push('<br clear="both">');
  lines.push('');
  lines.push('---');
  lines.push('');
}

function writeMarkdown(relativePath, content) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  console.error(`Generated: ${fullPath}`);
}

function makeHeader(title, listings, navLinks) {
  const lines = [
    `# ${title}`,
    '',
    `Last updated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
    '',
    `**${listings.length} listings**`,
    '',
  ];
  if (navLinks && navLinks.length > 0) {
    lines.push(navLinks.join(' · '));
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  return lines;
}

/**
 * Slugify a heading label for use as an anchor ID (GitHub-flavored style).
 */
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}

/**
 * Push a section heading with an explicit HTML anchor so TOC links work
 * in both Obsidian (which doesn't use GitHub-style heading IDs) and
 * the web view (which does via gfmHeadingId).
 */
function pushHeading(lines, label) {
  lines.push(`<a id="${slugify(label)}"></a>`);
  lines.push('');
  lines.push(`## ${label}`);
  lines.push('');
}

// --- View generators ---

const vaultDir = 'vault/trusted-housesitters';

const viewNav = [
  '[By Country](current-listings)',
  '[By Month](by-month)',
  '[By Duration](by-duration)',
  '[By Pet Type](by-pet-type)',
  '[New Listings](new-listings)',
];

/**
 * By Country (current-listings.md) — the original view
 */
function generateByCountry(listings) {
  const byCountry = {};
  for (const listing of listings) {
    const country = listing.country || 'Unknown';
    if (!byCountry[country]) byCountry[country] = [];
    byCountry[country].push(listing);
  }

  const sortedCountries = Object.keys(byCountry).sort();
  for (const country of sortedCountries) {
    byCountry[country].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }

  const lines = makeHeader('Housesit Listings — By Country', listings, viewNav);

  // TOC
  for (const country of sortedCountries) {
    const flag = countryFlag(country);
    const flagPrefix = flag ? `${flag} ` : '';
    lines.push(`- [${flagPrefix}${country}](#${slugify(country)}) (${byCountry[country].length})`);
  }
  lines.push('', '---', '');

  for (const country of sortedCountries) {
    pushHeading(lines, country);
    for (const listing of byCountry[country]) {
      renderListingCard(listing, lines);
    }
  }

  writeMarkdown(`${vaultDir}/current-listings.md`, lines.join('\n'));
}

/**
 * By Month — grouped by start month
 */
function generateByMonth(listings) {
  const sorted = [...listings].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const byMonth = {};
  for (const listing of sorted) {
    const d = new Date(listing.start_date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(listing);
  }

  const months = Object.keys(byMonth).sort();
  const lines = makeHeader('Housesit Listings — By Month', listings, viewNav);

  // TOC
  for (const month of months) {
    const label = new Date(month + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    lines.push(`- [${label}](#${slugify(label)}) (${byMonth[month].length})`);
  }
  lines.push('', '---', '');

  for (const month of months) {
    const label = new Date(month + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    pushHeading(lines, label);
    for (const listing of byMonth[month]) {
      renderListingCard(listing, lines);
    }
  }

  writeMarkdown(`${vaultDir}/by-month.md`, lines.join('\n'));
}

/**
 * By Duration — short / medium / long stays
 */
function generateByDuration(listings) {
  const buckets = {
    'Short Stays (1–7 days)': [],
    'Medium Stays (1–3 weeks)': [],
    'Long Stays (3+ weeks)': [],
  };

  for (const listing of listings) {
    const d = listing.duration_days;
    if (d <= 7) buckets['Short Stays (1–7 days)'].push(listing);
    else if (d <= 21) buckets['Medium Stays (1–3 weeks)'].push(listing);
    else buckets['Long Stays (3+ weeks)'].push(listing);
  }

  // Sort each bucket by start date
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }

  const lines = makeHeader('Housesit Listings — By Duration', listings, viewNav);

  // TOC
  for (const [label, items] of Object.entries(buckets)) {
    if (items.length > 0) {
      lines.push(`- [${label}](#${slugify(label)}) (${items.length})`);
    }
  }
  lines.push('', '---', '');

  for (const [label, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    pushHeading(lines, label);
    for (const listing of items) {
      renderListingCard(listing, lines);
    }
  }

  writeMarkdown(`${vaultDir}/by-duration.md`, lines.join('\n'));
}

/**
 * By Pet Type — cats only / dogs only / mixed / other
 */
function generateByPetType(listings) {
  const buckets = {
    'Cats Only 🐱': [],
    'Dogs Only 🐶': [],
    'Cats & Dogs': [],
    'Other Pets': [],
  };

  for (const listing of listings) {
    const types = Object.keys(listing.animals || {});
    const hasCat = types.includes('Cat');
    const hasDog = types.includes('Dog');

    if (hasCat && !hasDog && types.length === 1) buckets['Cats Only 🐱'].push(listing);
    else if (hasDog && !hasCat && types.length === 1) buckets['Dogs Only 🐶'].push(listing);
    else if (hasCat && hasDog) buckets['Cats & Dogs'].push(listing);
    else buckets['Other Pets'].push(listing);
  }

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }

  const lines = makeHeader('Housesit Listings — By Pet Type', listings, viewNav);

  for (const [label, items] of Object.entries(buckets)) {
    if (items.length > 0) {
      lines.push(`- [${label}](#${slugify(label)}) (${items.length})`);
    }
  }
  lines.push('', '---', '');

  for (const [label, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    pushHeading(lines, label);
    for (const listing of items) {
      renderListingCard(listing, lines);
    }
  }

  writeMarkdown(`${vaultDir}/by-pet-type.md`, lines.join('\n'));
}

/**
 * New Listings — added in last 3 days, newest first
 */
function generateNewListings(listings) {
  const recent = listings
    .filter(l => new Date(l.date_added) >= threeDaysAgo)
    .sort((a, b) => new Date(b.date_added) - new Date(a.date_added));

  const lines = makeHeader(`New Listings (Last 3 Days)`, recent, viewNav);

  if (recent.length === 0) {
    lines.push('*No new listings in the last 3 days.*');
    lines.push('');
  } else {
    for (const listing of recent) {
      renderListingCard(listing, lines);
    }
  }

  writeMarkdown(`${vaultDir}/new-listings.md`, lines.join('\n'));
}

/**
 * Generate all markdown views
 */
function generateAllViews(listings) {
  generateByCountry(listings);
  generateByMonth(listings);
  generateByDuration(listings);
  generateByPetType(listings);
  generateNewListings(listings);
}

/**
 * Load cached listings
 */
function loadCache() {
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Save listings to cache
 */
function saveCache(listings) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(listings, null, 2));
}

/**
 * Merge new listings with cached, removing duplicates and expired
 */
function mergeListings(cached, scraped, reviewingIds = []) {
  const today = new Date().toISOString().split('T')[0];
  const byUrl = new Map();
  const expiredIds = [];
  const reviewingSet = new Set(reviewingIds);

  // Add cached listings (non-expired, non-reviewing), track removed ones for cleanup
  for (const listing of cached) {
    if (listing.start_date < today) {
      expiredIds.push(listing.id);
    } else if (reviewingSet.has(listing.id)) {
      expiredIds.push(listing.id);
      console.error(`Removing cached listing "${listing.title}" (closed to new applicants)`);
    } else {
      // Migrate legacy slugified IDs to numeric
      const correctId = getListingId(listing.url);
      if (listing.id !== correctId) {
        listing.image_local = null; // force re-download/migration with new ID
        listing.id = correctId;
      }
      byUrl.set(listing.url, listing);
    }
  }

  // Add/update with scraped listings
  for (const listing of scraped) {
    if (listing.start_date >= today) {
      const existing = byUrl.get(listing.url);
      if (existing) {
        // Keep original date_added
        listing.date_added = existing.date_added;
      }
      byUrl.set(listing.url, listing);
    }
  }

  return { listings: Array.from(byUrl.values()), expiredIds };
}

/**
 * Delete image files for expired listings
 */
function cleanupExpiredImages(expiredIds) {
  for (const id of expiredIds) {
    for (const dir of [vaultImagesDir, legacyImagesDir]) {
      const imgPath = path.join(dir, `${id}.jpg`);
      if (fs.existsSync(imgPath)) {
        try {
          fs.unlinkSync(imgPath);
          console.error(`Cleaned up image: ${imgPath}`);
        } catch (e) {
          console.error(`Failed to clean up ${imgPath}: ${e.message}`);
        }
      }
    }
  }
}

/**
 * Remove image files that don't correspond to any cached listing.
 */
function cleanupOrphanedImages(listings) {
  const cachedIds = new Set(listings.map(l => l.id));
  for (const dir of [vaultImagesDir, legacyImagesDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jpg')) continue;
      const id = file.replace('.jpg', '');
      if (!cachedIds.has(id)) {
        try {
          fs.unlinkSync(path.join(dir, file));
          console.error(`Cleaned up orphaned image: ${file}`);
        } catch (e) {
          console.error(`Failed to clean up orphaned image ${file}: ${e.message}`);
        }
      }
    }
  }
}

/**
 * Check cached listings for reviewing/confirmed status by fetching their
 * detail pages from within the browser (reusing auth cookies).  Looks for
 * `"isReviewing":true` or `"isConfirmed":true` in the raw HTML, which is
 * faster and more reliable than parsing the full __INITIAL_STATE__ blob.
 */
async function checkCachedListingStatus(page, listings, alreadyCheckedIds) {
  const toCheck = listings.filter(l => !alreadyCheckedIds.has(l.id));
  if (toCheck.length === 0) return [];

  console.error(`Checking ${toCheck.length} cached listings for reviewing status...`);
  const reviewingIds = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
    const batch = toCheck.slice(i, i + BATCH_SIZE);
    const results = await page.evaluate(async (items) => {
      const checks = items.map(async ({ url, id, startDate, endDate }) => {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          const html = await resp.text();
          // Match assignments by date range to find the specific one we cached.
          // A listing profile can have many assignments; we need the one whose
          // dates match our cached entry.
          const re = /"id":"\d+","startDate":"([^"]+)","endDate":"([^"]+)"[^}]*?"isReviewing":(true|false|null)[^}]*?"isConfirmed":(true|false|null)[^}]*?"canApply":(true|false|null)/g;
          let m;
          while ((m = re.exec(html)) !== null) {
            if (m[1] === startDate && m[2] === endDate) {
              const isReviewing = m[3] === 'true';
              const isConfirmed = m[4] === 'true';
              const canApply = m[5] === 'true';
              if ((isReviewing || isConfirmed) && !canApply) {
                return { id, reviewing: true };
              }
              return { id, reviewing: false };
            }
          }
          // No matching assignment found — may have been removed
          return { id, reviewing: false };
        } catch {
          return { id, reviewing: false };
        }
      });
      return Promise.all(checks);
    }, batch.map(l => ({ url: l.url, id: l.id, startDate: l.start_date, endDate: l.end_date })));

    for (const { id, reviewing } of results) {
      if (reviewing) {
        const listing = batch.find(l => l.id === id);
        console.error(`  "${listing?.title}" (${id}) is closed to new applicants`);
        reviewingIds.push(id);
      }
    }

    if (i + BATCH_SIZE < toCheck.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if ((i / BATCH_SIZE) % 20 === 19) {
      console.error(`  ...checked ${i + BATCH_SIZE} of ${toCheck.length} listings`);
    }
  }

  console.error(`Found ${reviewingIds.length} reviewing listings out of ${toCheck.length} checked`);
  return reviewingIds;
}

/**
 * Main entry point
 */
async function main() {
  try {
    let allListings;

    if (contextOnly) {
      // Just read from cache for AI context gathering
      console.error('CONTEXT_ONLY mode - reading from cache');
      allListings = loadCache();
    } else {
      // Full scrape
      const { listings: scrapedListings, reviewingIds, page, browser } = await scrapeListings();
      let expiredIds;

      try {
        // Merge with cache (removing expired and reviewing listings from search pages)
        const cachedListings = loadCache();
        ({ listings: allListings, expiredIds } = mergeListings(cachedListings, scrapedListings, reviewingIds));

        // Check remaining cached listings for reviewing status
        const scrapedIdSet = new Set([
          ...reviewingIds,
          ...scrapedListings.map(l => l.id)
        ]);
        const moreReviewingIds = await checkCachedListingStatus(page, allListings, scrapedIdSet);

        // Remove newly-found reviewing listings and clean up their images
        if (moreReviewingIds.length > 0) {
          const reviewingSet = new Set(moreReviewingIds);
          allListings = allListings.filter(l => !reviewingSet.has(l.id));
          expiredIds.push(...moreReviewingIds);
        }
      } finally {
        await browser.close();
      }

      // Download images to vault for new listings
      for (const listing of allListings) {
        if (listing.image_url && !listing.image_local) {
          listing.image_local = await downloadImage(listing.image_url, listing.id);
        }
      }

      // Save cache AFTER image download so image_local paths are persisted
      saveCache(allListings);

      // Clean up images for expired and reviewing listings
      cleanupExpiredImages(expiredIds);

      // Safety net: remove any orphaned images not in the cache
      cleanupOrphanedImages(allListings);
    }

    // Apply filters
    const filteredListings = allListings.filter(passesFilters);
    console.error(`${filteredListings.length} listings after filtering (from ${allListings.length} total)`);

    // Generate markdown views
    if (filteredListings.length > 0) {
      generateAllViews(filteredListings);
    }

    // Transform to issues schema for database
    const entries = filteredListings.map(listing => ({
      id: listing.id,
      title: listing.title,
      state: 'open',
      opened_at: listing.date_added + 'T00:00:00Z',
      url: listing.url,
      body: null,
      metadata: JSON.stringify({
        start_date: listing.start_date,
        end_date: listing.end_date,
        duration_days: listing.duration_days,
        city: listing.city,
        state: listing.state,
        country: listing.country,
        animals: listing.animals,
        image: listing.image_local || null,
        date_added: listing.date_added
      })
    }));

    // Output JSON
    console.log(JSON.stringify({
      entries,
      total: entries.length,
      incremental: false
    }));

  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.log(JSON.stringify({
      error: error.message,
      entries: []
    }));
    process.exit(1);
  }
}

main();

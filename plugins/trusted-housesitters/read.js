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
const imagesDir = path.join(cacheDir, 'images');

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

  fs.mkdirSync(imagesDir, { recursive: true });
  const localPath = path.join(imagesDir, `${listingId}.jpg`);

  // Skip if already exists
  if (fs.existsSync(localPath)) {
    return localPath;
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
  const match = url.match(/\/(\d+)(?:\?|$)/);
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
    let pageNum = 1;

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

      const listingCards = $('div[data-testid="ListingCard__container"]');
      console.error(`Found ${listingCards.length} listing cards on page ${pageNum}`);

      if (listingCards.length === 0) {
        console.error('No listings found on page, stopping');
        break;
      }

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
          allListings.push({
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
      });

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
    return allListings;

  } finally {
    await browser.close();
  }
}

/**
 * Generate markdown file for browsing listings
 */
function generateMarkdown(listings, outputPath) {
  // Group by country
  const byCountry = {};
  for (const listing of listings) {
    const country = listing.country || 'Unknown';
    if (!byCountry[country]) {
      byCountry[country] = [];
    }
    byCountry[country].push(listing);
  }

  // Sort countries alphabetically, sort listings by start date within each country
  const sortedCountries = Object.keys(byCountry).sort();
  for (const country of sortedCountries) {
    byCountry[country].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }

  // Build markdown
  const lines = [
    '# Current Housesit Listings',
    '',
    `Last updated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
    '',
    `**Total: ${listings.length} listings**`,
    '',
    '---',
    ''
  ];

  // Table of contents
  lines.push('## Countries');
  lines.push('');
  for (const country of sortedCountries) {
    lines.push(`- [${country}](#${country.toLowerCase().replace(/\s+/g, '-')}) (${byCountry[country].length})`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Listings by country
  const petEmoji = {
    Dog: '🐶',
    Cat: '🐱',
    Horse: '🐴',
    Bird: '🐦',
    Fish: '🐟',
    Rabbit: '🐰',
    Reptile: '🦎',
    'Small pet': '🐹'
  };

  const today = new Date();
  const oneDayAgo = new Date(today - 24 * 60 * 60 * 1000);

  for (const country of sortedCountries) {
    lines.push(`## ${country}`);
    lines.push('');

    for (const listing of byCountry[country]) {
      const isNew = new Date(listing.date_added) >= oneDayAgo;
      const newBadge = isNew ? ' 🆕' : '';

      lines.push(`### ${listing.title}${newBadge}`);
      lines.push('');

      const startDate = new Date(listing.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const endDate = new Date(listing.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      lines.push(`**Dates:** ${startDate} - ${endDate} (${listing.duration_days} days)`);

      const locationParts = [listing.city, listing.state, listing.country].filter(Boolean);
      lines.push(`**Location:** ${locationParts.join(', ')}`);

      if (Object.keys(listing.animals).length > 0) {
        const petStrings = Object.entries(listing.animals).map(([pet, count]) => {
          const emoji = petEmoji[pet] || '🐾';
          return `${count} ${pet.toLowerCase()}${count > 1 ? 's' : ''} ${emoji}`;
        });
        lines.push(`**Pets:** ${petStrings.join(', ')}`);
      }

      lines.push('');
      lines.push(`[View on TrustedHousesitters](${listing.url})`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Write file
  const fullPath = path.join(projectRoot, outputPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, lines.join('\n'));
  console.error(`Generated markdown: ${fullPath}`);
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
function mergeListings(cached, scraped) {
  const today = new Date().toISOString().split('T')[0];
  const byUrl = new Map();

  // Add cached listings (non-expired)
  for (const listing of cached) {
    if (listing.start_date >= today) {
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

  return Array.from(byUrl.values());
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
      const scrapedListings = await scrapeListings();

      // Merge with cache
      const cachedListings = loadCache();
      allListings = mergeListings(cachedListings, scrapedListings);

      // Save updated cache
      saveCache(allListings);

      // Download images for new listings
      for (const listing of allListings) {
        if (listing.image_url && !listing.image_local) {
          listing.image_local = await downloadImage(listing.image_url, listing.id);
        }
      }
    }

    // Apply filters
    const filteredListings = allListings.filter(passesFilters);
    console.error(`${filteredListings.length} listings after filtering (from ${allListings.length} total)`);

    // Generate markdown file (skip in CONTEXT_ONLY mode)
    if (!contextOnly && filteredListings.length > 0) {
      generateMarkdown(filteredListings, outputFile);
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

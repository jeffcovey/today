/**
 * Shared browser utilities for TrustedHousesitters plugin.
 * Used by both login.js and read.js.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

/**
 * Get the path to the cookie file for a given source ID.
 * @param {string} sourceId - e.g. "trusted-housesitters/default"
 * @returns {string}
 */
export function getCookiePath(sourceId) {
  const safeName = sourceId.replace(/\//g, '-');
  return path.join(PROJECT_ROOT, '.data', 'trusted-housesitters', `cookies-${safeName}.json`);
}

/**
 * Save browser cookies to disk.
 * @param {import('puppeteer').Page} page
 * @param {string} sourceId
 */
export async function saveCookies(page, sourceId) {
  const cookies = await page.cookies();
  const cookiePath = getCookiePath(sourceId);
  fs.mkdirSync(path.dirname(cookiePath), { recursive: true });
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
}

/**
 * Load cookies from disk and set them on the page.
 * @param {import('puppeteer').Page} page
 * @param {string} sourceId
 * @returns {boolean} true if cookies were loaded
 */
export async function loadCookies(page, sourceId) {
  const cookiePath = getCookiePath(sourceId);
  if (!fs.existsSync(cookiePath)) {
    return false;
  }
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    if (Array.isArray(cookies) && cookies.length > 0) {
      await page.setCookie(...cookies);
      return true;
    }
  } catch {
    // Corrupt cookie file
  }
  return false;
}

/**
 * Delete cookie file for a source.
 * @param {string} sourceId
 */
export function clearCookies(sourceId) {
  const cookiePath = getCookiePath(sourceId);
  try {
    fs.unlinkSync(cookiePath);
  } catch {
    // File may not exist
  }
}

/**
 * Launch Puppeteer with system Chrome detection.
 * @returns {Promise<import('puppeteer').Browser>}
 */
export async function launchBrowser() {
  const systemChromePaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];

  let executablePath;
  for (const chromePath of systemChromePaths) {
    try {
      await fs.promises.access(chromePath);
      executablePath = chromePath;
      console.error(`Using system browser: ${chromePath}`);
      break;
    } catch {
      // Not found, try next
    }
  }

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-setuid-sandbox'
    ]
  });
}

/**
 * Create a new page with a realistic user agent.
 * @param {import('puppeteer').Browser} browser
 * @returns {Promise<import('puppeteer').Page>}
 */
export async function createPage(browser) {
  const page = await browser.newPage();
  // Use the bundled Chrome's real UA but strip the "Headless" marker
  const defaultUA = await browser.userAgent();
  await page.setUserAgent(defaultUA.replace(/Headless/g, ''));
  return page;
}

/**
 * Heuristic detection of a verification/code-entry page.
 * Looks for text like "verification"/"enter the code" and input patterns
 * (multiple maxlength="1" inputs or a single maxlength="6" input).
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
export async function isVerificationPage(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const hasVerificationText =
      bodyText.includes('verification') ||
      bodyText.includes('enter the code') ||
      bodyText.includes('enter code') ||
      bodyText.includes('verify your') ||
      bodyText.includes('check your email');

    if (!hasVerificationText) return false;

    // Check for individual digit inputs (maxlength="1")
    const singleCharInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleCharInputs.length >= 4) return true;

    // Check for a single code input (maxlength="6")
    const codeInput = document.querySelector('input[maxlength="6"]');
    if (codeInput) return true;

    return false;
  });
}

/**
 * Check if the current session is valid by navigating to the listings page
 * and checking whether we get redirected to login.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if session is valid
 */
export async function isSessionValid(page) {
  const listingsUrl = 'https://www.trustedhousesitters.com/house-and-pet-sitting-assignments/';
  await page.goto(listingsUrl, { waitUntil: 'networkidle2' });

  const currentUrl = page.url();
  // If we ended up on a login page, the session is not valid
  if (currentUrl.includes('/login') || currentUrl.includes('/sign-in')) {
    return false;
  }

  // Also check for verification page
  if (await isVerificationPage(page)) {
    return false;
  }

  return true;
}

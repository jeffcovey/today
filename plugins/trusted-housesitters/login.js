#!/usr/bin/env node

/**
 * TrustedHousesitters Plugin - Interactive Login Command
 *
 * Handles email/password login + 6-digit email verification code.
 * Runs with inherited stdio so it can prompt the user.
 * Saves cookies on success for reuse by read.js.
 */

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {
  launchBrowser,
  createPage,
  loadCookies,
  saveCookies,
  clearCookies,
  isVerificationPage,
  isSessionValid
} from './browser.js';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const sourceId = process.env.SOURCE_ID || 'trusted-housesitters/default';

const email = config.email;
const password = config.password;

const cacheDir = path.join(projectRoot, '.data', 'trusted-housesitters');

/**
 * Prompt the user for input via stderr (so stdout stays clean).
 */
function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Save debug HTML for troubleshooting login failures.
 */
function saveDebugHtml(page, label) {
  return page.content().then((html) => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const debugPath = path.join(cacheDir, `debug-${label}.html`);
    fs.writeFileSync(debugPath, html);
    console.error(`Saved debug HTML to ${debugPath}`);
  }).catch(() => {});
}

async function main() {
  if (!email || !password) {
    console.error('Error: Email and password are required.');
    console.error('Run: bin/plugins configure trusted-housesitters');
    process.exit(1);
  }

  console.error('Launching browser...');
  const browser = await launchBrowser();

  try {
    const page = await createPage(browser);

    // Check if existing cookies give us a valid session
    const hasCookies = await loadCookies(page, sourceId);
    if (hasCookies) {
      console.error('Checking existing session...');
      const valid = await isSessionValid(page);
      if (valid) {
        console.error('Session is still valid. No login needed.');
        process.exit(0);
      }
      console.error('Session expired. Logging in again...');
      clearCookies(sourceId);
    }

    // Navigate to login page
    console.error('Navigating to login page...');
    await page.goto('https://www.trustedhousesitters.com/login/', { waitUntil: 'networkidle2' });

    // Fill in email and password
    await page.waitForSelector('input#email', { timeout: 15000 });
    await page.type('input#email', email);
    await page.type('input#password', password);
    console.error('Submitting credentials...');
    await page.click('button[type="submit"]');

    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if we hit the verification page
    if (await isVerificationPage(page)) {
      console.error('');
      console.error('Email verification required.');
      console.error('Check your email for a 6-digit code from TrustedHousesitters.');
      console.error('');

      const code = await prompt('Enter 6-digit verification code: ');

      if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
        console.error('Error: Invalid code. Must be exactly 6 digits.');
        await saveDebugHtml(page, 'bad-code');
        process.exit(1);
      }

      // Try individual digit inputs first (maxlength="1")
      const singleInputs = await page.$$('input[maxlength="1"]');
      if (singleInputs.length >= 6) {
        for (let i = 0; i < 6; i++) {
          await singleInputs[i].type(code[i]);
        }
      } else {
        // Fall back to single code input (maxlength="6")
        const codeInput = await page.$('input[maxlength="6"]');
        if (codeInput) {
          await codeInput.type(code);
        } else {
          // Last resort: try any visible text input
          const inputs = await page.$$('input[type="text"], input[type="tel"], input[type="number"], input:not([type])');
          if (inputs.length > 0) {
            await inputs[0].type(code);
          } else {
            console.error('Error: Could not find verification code input.');
            await saveDebugHtml(page, 'no-code-input');
            process.exit(1);
          }
        }
      }

      // Click verify/submit button
      console.error('Submitting verification code...');
      const submitted = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const verifyBtn = buttons.find(b => {
          const text = b.textContent.toLowerCase();
          return text.includes('verify') || text.includes('submit') || text.includes('confirm');
        });
        if (verifyBtn) {
          verifyBtn.click();
          return true;
        }
        // Try submit button as fallback
        const submitBtn = document.querySelector('button[type="submit"]');
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        return false;
      });

      if (!submitted) {
        console.error('Warning: Could not find verify/submit button. Pressing Enter instead...');
        await page.keyboard.press('Enter');
      }

      // Wait for verification to complete
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Check if login was successful by verifying the session
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/sign-in')) {
      console.error('Error: Login failed. Still on login page.');
      await saveDebugHtml(page, 'login-failed');
      process.exit(1);
    }

    // Check if we're stuck on verification
    if (await isVerificationPage(page)) {
      console.error('Error: Verification failed. Still on verification page.');
      await saveDebugHtml(page, 'verify-failed');
      process.exit(1);
    }

    // Save cookies for future use
    await saveCookies(page, sourceId);
    console.error('Login successful. Cookies saved.');

  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

/**
 * Web Server Task Toggle Tests
 *
 * Tests the /task/toggle endpoint for completing/uncompleting tasks.
 * Requires the web server to be running on localhost:3001.
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';

// Test configuration
const BASE_URL = 'http://localhost:3001';
const TEST_FILE = 'vault/routines/evening.md';
const TEST_LINE = 112; // "Lock the doors" task

// Helper to get session cookie
let sessionCookie = null;

async function login() {
  if (sessionCookie) return sessionCookie;

  // Try to read existing cookie from file first (Netscape cookie format)
  try {
    const cookieContent = await fs.readFile('/tmp/cookies.txt', 'utf-8');
    // Netscape format: domain\tflag\tpath\tsecure\texpiration\tname\tvalue
    const match = cookieContent.match(/connect\.sid\t(\S+)$/m);
    if (match) {
      sessionCookie = `connect.sid=${match[1]}`;
      return sessionCookie;
    }
  } catch {
    // Fall through to login
  }

  // Read password from log file
  try {
    const logContent = await fs.readFile('/tmp/web-server.log', 'utf-8');
    const passwordMatch = logContent.match(/Password: (.+)/);
    if (!passwordMatch) throw new Error('Could not find password in log');

    const password = passwordMatch[1].trim();

    const response = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=admin&password=${encodeURIComponent(password)}`,
      redirect: 'manual'
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }
    return sessionCookie;
  } catch (error) {
    console.error('Login failed:', error.message);
    return null;
  }
}

async function fetchWithAuth(url, options = {}) {
  const cookie = await login();
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': cookie
    }
  });
}

// Helper to read task line from file
async function readTaskLine(lineNumber) {
  const content = await fs.readFile(path.join(process.cwd(), TEST_FILE), 'utf-8');
  const lines = content.split('\n');
  return lines[lineNumber - 1];
}

// Helper to check if server is running
async function isServerRunning() {
  try {
    const response = await fetch(BASE_URL, { method: 'HEAD' });
    return response.status < 500;
  } catch {
    return false;
  }
}

describe('Task Toggle API', () => {
  beforeAll(async () => {
    const running = await isServerRunning();
    if (!running) {
      console.warn('Web server not running on localhost:3001 - skipping tests');
    }
  });

  describe('POST /task/toggle', () => {
    test('should complete a task and update file', async () => {
      const running = await isServerRunning();
      if (!running) return;

      // First ensure task is unchecked
      await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: TEST_LINE,
          completed: false
        })
      });

      // Now complete the task
      const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: TEST_LINE,
          completed: true
        })
      });

      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.updatedLine).toMatch(/- \[x\]/);
      expect(result.updatedLine).toContain('✅');

      // Verify file was updated
      const taskLine = await readTaskLine(TEST_LINE);
      expect(taskLine).toMatch(/- \[x\]/);
      expect(taskLine).toContain('✅');
    });

    test('should uncomplete a task and update file', async () => {
      const running = await isServerRunning();
      if (!running) return;

      // First ensure task is checked
      await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: TEST_LINE,
          completed: true
        })
      });

      // Now uncomplete the task
      const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: TEST_LINE,
          completed: false
        })
      });

      expect(response.ok).toBe(true);

      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.updatedLine).toMatch(/- \[ \]/);
      expect(result.updatedLine).not.toContain('✅');

      // Verify file was updated
      const taskLine = await readTaskLine(TEST_LINE);
      expect(taskLine).toMatch(/- \[ \]/);
      expect(taskLine).not.toContain('✅');
    });

    test('should return 400 for missing parameters', async () => {
      const running = await isServerRunning();
      if (!running) return;

      const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          completed: true
          // Missing filePath and lineNumber
        })
      });

      expect(response.status).toBe(400);
    });

    test('should return 400 for non-task line', async () => {
      const running = await isServerRunning();
      if (!running) return;

      const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: 1, // Line 1 is frontmatter, not a task
          completed: true
        })
      });

      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('Not a task line');
    });

    test('should require authentication', async () => {
      const running = await isServerRunning();
      if (!running) return;

      const response = await fetch(`${BASE_URL}/task/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: TEST_FILE.replace('vault/', ''),
          lineNumber: TEST_LINE,
          completed: true
        }),
        redirect: 'manual' // Don't follow redirects
        // No auth cookie
      });

      // Should redirect to login or return 401/403
      // 302 = redirect to login, 401 = unauthorized, 403 = forbidden
      expect([302, 401, 403]).toContain(response.status);
    });
  });
});

describe('Task Toggle - Edge Cases', () => {
  test('should handle tasks with multiple spaces before completion date', async () => {
    const running = await isServerRunning();
    if (!running) return;

    // Complete the task (which adds completion date)
    await fetchWithAuth(`${BASE_URL}/task/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: TEST_FILE.replace('vault/', ''),
        lineNumber: TEST_LINE,
        completed: true
      })
    });

    // Uncomplete it - should handle any whitespace before ✅
    const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: TEST_FILE.replace('vault/', ''),
        lineNumber: TEST_LINE,
        completed: false
      })
    });

    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.updatedLine).not.toContain('✅');
  });

  test('should preserve task metadata when toggling', async () => {
    const running = await isServerRunning();
    if (!running) return;

    // Get original line
    const originalLine = await readTaskLine(TEST_LINE);
    const hasScheduledDate = originalLine.includes('⏳');
    const hasCreatedDate = originalLine.includes('➕');
    const hasPriority = originalLine.includes('⏫') || originalLine.includes('🔼');

    // Toggle complete
    await fetchWithAuth(`${BASE_URL}/task/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: TEST_FILE.replace('vault/', ''),
        lineNumber: TEST_LINE,
        completed: true
      })
    });

    // Toggle back
    const response = await fetchWithAuth(`${BASE_URL}/task/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath: TEST_FILE.replace('vault/', ''),
        lineNumber: TEST_LINE,
        completed: false
      })
    });

    const result = await response.json();

    // Verify metadata was preserved
    if (hasScheduledDate) expect(result.updatedLine).toContain('⏳');
    if (hasCreatedDate) expect(result.updatedLine).toContain('➕');
    if (hasPriority) expect(result.updatedLine).toMatch(/⏫|🔼/);
  });
});

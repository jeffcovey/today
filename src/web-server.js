#!/usr/bin/env node

import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import path from 'path';
import crypto from "crypto";
import { execSync } from 'child_process';
import fs from 'fs/promises';
import { marked } from 'marked';
import { gfmHeadingId, getHeadingList } from 'marked-gfm-heading-id';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDatabase } from './database-service.js';
import { replaceTagsWithEmojis } from './tag-emoji-mappings.js';
import { getMarkdownFileCache } from './markdown-file-cache.js';
import { getAbsoluteVaultPath } from './config.js';
import yaml from 'js-yaml';
import {
  chatWithFile,
  chatWithDirectory,
  loadConversation,
  saveConversation,
  clearConversation,
  getChatProviderName,
  createChatTools,
} from './ai-chat/index.js';

// Configure marked extensions
marked.use(gfmHeadingId());
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  }
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Debug logging - set DEBUG=true in environment to enable verbose logging
const DEBUG = process.env.DEBUG === 'true';
const debug = (...args) => DEBUG && console.log('[DEBUG]', ...args);

// Web server only needs read-only access, disable Turso sync for faster startup
const getReadOnlyDatabase = () => getDatabase('.data/today.db', { autoSync: false });

const app = express();
const PORT = process.env.WEB_PORT || 3000;
app.set("trust proxy", 1);
const VAULT_PATH = getAbsoluteVaultPath();
const TEMPLATES_PATH = path.join(__dirname, 'web', 'templates');

// Template system - loads HTML templates from files
const templateCache = new Map();

async function loadTemplate(name) {
  // In development, always reload from disk for hot reloading
  // In production, cache templates
  const isDev = process.env.NODE_ENV !== 'production';

  if (!isDev && templateCache.has(name)) {
    return templateCache.get(name);
  }

  const templatePath = path.join(TEMPLATES_PATH, `${name}.html`);
  try {
    const content = await fs.readFile(templatePath, 'utf8');
    if (!isDev) {
      templateCache.set(name, content);
    }
    return content;
  } catch (error) {
    debug(`Template not found: ${name}`, error.message);
    return null;
  }
}

function renderTemplate(template, data = {}) {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value ?? '');
  }
  return result;
}

// Track pending markdown regenerations
const pendingMarkdownUpdates = new Map();
const MARKDOWN_UPDATE_DELAY = 3000; // 3 seconds

// Function to regenerate markdown file sections
async function regenerateMarkdownSections(filePath) {
  try {
    debug(`Regenerating markdown sections for: ${filePath}`);
    const { execSync } = await import('child_process');
    
    // Run the tasks sync command to regenerate the markdown
    execSync('bin/tasks sync --quick', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    debug(`Markdown sections regenerated for: ${filePath}`);
  } catch (error) {
    debug(`Failed to regenerate markdown for ${filePath}:`, error.message);
  }
}

// Debounced markdown update
function scheduleMarkdownUpdate(filePath) {
  // Clear any existing timeout for this file
  if (pendingMarkdownUpdates.has(filePath)) {
    clearTimeout(pendingMarkdownUpdates.get(filePath));
  }
  
  // Schedule a new update
  const timeoutId = setTimeout(() => {
    pendingMarkdownUpdates.delete(filePath);
    regenerateMarkdownSections(filePath);
  }, MARKDOWN_UPDATE_DELAY);
  
  pendingMarkdownUpdates.set(filePath, timeoutId);
  debug(`Scheduled markdown update for ${filePath} in ${MARKDOWN_UPDATE_DELAY}ms`);
}

// Cache for rendered Markdown
const renderCache = new Map();
const fileStatsCache = new Map();
const CACHE_MAX_SIZE = 100; // Maximum number of cached files
const CACHE_TTL = 60 * 60 * 1000; // 1 hour TTL for cache entries

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Set up SQLite session store
const SQLiteStore = connectSqlite3(session);

// Session middleware - must come before auth
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, '..', '.data'),
    table: 'sessions',
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Authentication credentials
const validUser = process.env.WEB_USER || "admin";

// Password: use env var, or generate and store encrypted
function getOrCreatePassword() {
  if (process.env.WEB_PASSWORD) {
    return process.env.WEB_PASSWORD;
  }

  // Generate a secure random password
  const newPassword = crypto.randomBytes(24).toString('base64');

  // Store encrypted using dotenvx
  try {
    execSync(`npx dotenvx set WEB_PASSWORD "${newPassword}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('Generated new web password (encrypted in .env)');
  } catch (error) {
    console.error('Warning: Could not save password to .env:', error.message);
  }

  return newPassword;
}

const validPassword = getOrCreatePassword();

function sessionAuth(req, res, next) {
  if (req.path === "/auth/login" || req.path === "/auth/logout") return next();
  if (req.session && req.session.authenticated) return next();
  // Don't save static asset requests as return URL
  if (!req.path.match(/\.(ico|png|jpg|jpeg|gif|css|js|woff|woff2|ttf|svg)$/)) {
    req.session.returnTo = req.originalUrl;
  }
  res.redirect("/auth/login");
}

app.get("/auth/login", async (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect("/");
  const template = await loadTemplate('login');
  if (template) {
    res.send(template);
  } else {
    // Fallback if template not found
    res.send('<h1>Login</h1><form method="POST"><input name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button>Login</button></form>');
  }
});

app.post("/auth/login", express.urlencoded({extended:true}), (req,res) => {
  if (req.body.username === validUser && req.body.password === validPassword) {
    req.session.authenticated = true;
    req.session.save(() => res.redirect(req.session.returnTo || "/"));
  } else res.redirect("/auth/login");
});

app.get("/auth/logout", (req,res) => req.session.destroy(() => res.redirect("/auth/login")));

const authMiddleware = sessionAuth;
app.use('/static', express.static(path.join(__dirname, 'web', 'public')));

// MDBootstrap and custom styles (CSS moved to web/public/css/style.css)
const pageStyle = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- Font Awesome -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet"/>
<!-- Google Fonts -->
<link href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap" rel="stylesheet"/>
<!-- MDB -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.min.css" rel="stylesheet"/>
<!-- Highlight.js theme for code blocks -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" rel="stylesheet"/>
<!-- Custom styles -->
<link href="/static/css/style.css" rel="stylesheet"/>
`;

// Common scripts for all pages
const pageScripts = `
<script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
<script src="/static/js/common.js"></script>
`;

// Scripts for pages with chat (includes marked.js for markdown)
const pageScriptsWithMarked = `
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
${pageScripts}
`;

// Helper to get navbar
function getNavbar(title = 'Today', icon = 'fa-folder-open', options = {}) {
  const { showSearch = true, searchValue = '' } = options;

  const searchForm = showSearch ? `
          <form class="d-flex ms-auto" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput"${searchValue ? ` value="${searchValue.replace(/"/g, '&quot;')}"` : ''} style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit">
                <i class="fas fa-search"></i>
              </button>
            </div>
          </form>` : '';

  return `<!-- Loading Spinner Overlay -->
      <div id="loadingOverlay" class="loading-overlay">
        <div class="loading-spinner"></div>
      </div>
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas ${icon} me-2"></i>${title}
          </a>${searchForm}
        </div>
      </nav>`;
}

// Helper to get breadcrumb navigation
function getBreadcrumb(filePath) {
  const parts = filePath.split('/').filter(Boolean);
  let currentPath = '';
  const links = ['<a href="/">Home</a>'];

  for (const part of parts) {
    currentPath += '/' + part;
    links.push(`<a href="${currentPath}">${part}</a>`);
  }

  return links.join(' / ');
}

// Helper to get AI assistant chat panel
function getAIAssistantPanel(placeholderText = 'Ask me anything...') {
  return `
    <div class="ai-assistant-wrapper" id="aiAssistantWrapper">
    <div class="card shadow-sm">
      <div class="card-header bg-primary text-white d-flex align-items-center" id="aiAssistantHeader">
        <i class="fas fa-robot me-2"></i>
        <span>AI Assistant</span>
        <button class="toggle-btn desktop-only ms-auto" onclick="toggleAIAssistant()" title="Collapse">
          <i class="fas fa-chevron-right" id="toggleIcon"></i>
        </button>
      </div>
      <div class="chat-container">
        <div class="chat-messages" id="chatMessages">
          <div class="text-center text-muted p-3">
            <small>${placeholderText}</small>
          </div>
        </div>
        <div class="chat-input-area">
          <div class="input-group">
            <textarea
              class="form-control"
              id="chatInput"
              placeholder="Type your message or /clear to reset..."
              rows="4"
              onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
            <button class="btn btn-primary" onclick="sendMessage()">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>`;
}

// Helper to get floating toggle button
function getFloatingToggleBtn() {
  return `<button class="floating-toggle-btn" onclick="toggleAIAssistant()" title="Show AI Assistant">
        <i class="fas fa-robot"></i>
      </button>`;
}

// Helper to get timer widget (active or idle state)
function getTimerWidget(timer) {
  if (timer) {
    return `
        <div class="alert alert-info d-flex align-items-center mb-3" role="alert" data-timer-start="${timer.startTimeISO}">
          <i class="fas fa-clock me-2"></i>
          <div class="flex-grow-1">
            <strong>${timer.description}</strong>
            <br>
            <small>Started at ${timer.startTime} • Duration: <span class="timer-duration">${timer.duration}</span></small>
          </div>
          <a href="#" id="stopTimerBtn" onclick="
            const btn = this;
            const icon = btn.querySelector('i');
            const text = btn.querySelector('.btn-text');
            btn.disabled = true;
            btn.style.pointerEvents = 'none';
            icon.className = 'fas fa-spinner fa-spin';
            text.textContent = ' Stopping...';
            fetch('/api/track/stop', {method: 'POST'}).then(() => location.reload()).catch(() => {
              btn.disabled = false;
              btn.style.pointerEvents = 'auto';
              icon.className = 'fas fa-stop';
              text.textContent = ' Stop';
            });
            return false;" class="btn btn-sm btn-outline-dark ms-2">
            <i class="fas fa-stop"></i><span class="btn-text"> Stop</span>
          </a>
        </div>`;
  } else {
    return `
        <div class="alert alert-secondary d-flex align-items-center mb-3" role="alert">
          <i class="fas fa-clock me-2"></i>
          <div class="input-group flex-grow-1">
            <input type="text" class="form-control" id="timerDescription" placeholder="What are you working on? (include #topic/tags)" onkeypress="if(event.key==='Enter'){event.preventDefault();document.getElementById('startTimerBtn').click();}">
            <button class="btn btn-primary" id="startTimerBtn" onclick="
              const btn = this;
              const icon = btn.querySelector('i');
              const text = btn.querySelector('.btn-text');
              const desc = document.getElementById('timerDescription').value;
              if (!desc.trim()) return;
              btn.disabled = true;
              icon.className = 'fas fa-spinner fa-spin';
              text.textContent = ' Starting...';
              fetch('/api/track/start', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({description: desc})}).then(() => location.reload()).catch(() => {
                btn.disabled = false;
                icon.className = 'fas fa-play';
                text.textContent = ' Start';
              })">
              <i class="fas fa-play"></i><span class="btn-text"> Start</span>
            </button>
          </div>
        </div>`;
  }
}

// Get configured timezone
function getConfiguredTimezone() {
  try {
    const { execSync } = require('child_process');
    const result = execSync('bin/get-config timezone', { encoding: 'utf8' }).trim();
    return result || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

// Helper function to get current time tracking timer info
async function getCurrentTimer() {
  const timerFile = path.join(__dirname, '..', 'vault', 'logs', 'time-tracking', 'current-timer.md');
  const timezone = getConfiguredTimezone();

  try {
    const content = await fs.readFile(timerFile, 'utf8');
    const trimmed = content.trim();

    // If file is empty, no timer running
    if (!trimmed) {
      return null;
    }

    const lines = trimmed.split('\n');

    if (lines.length < 2) {
      return null;
    }

    const description = lines[0];
    const startTime = lines[1];

    // Calculate duration
    const start = new Date(startTime);
    const now = new Date();
    const durationMs = now - start;
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));

    // Format start time in configured timezone
    const formattedStart = start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone
    });

    return {
      description,
      startTime: formattedStart,
      startTimeISO: startTime,
      duration: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
    };
  } catch (error) {
    // No timer running or file doesn't exist
    return null;
  }
}

// Initialize markdown file cache
const markdownCache = getMarkdownFileCache();

// Helper function to extract title from markdown file (using cache)
async function getMarkdownTitle(filePath) {
  const metadata = await markdownCache.getFileMetadata(filePath);
  return metadata.title;
}

// Helper function to get ISO week number
function getWeekNumber(date) {
  // ISO week date standard: weeks start on Monday, first week contains January 4th
  const tempDate = new Date(date.valueOf());
  const dayNum = (date.getDay() + 6) % 7; // Monday = 0, Sunday = 6
  tempDate.setDate(tempDate.getDate() - dayNum + 3); // Thursday of current week
  const firstThursday = tempDate.valueOf();
  tempDate.setMonth(0, 1); // January 1st
  if (tempDate.getDay() !== 4) { // If not Thursday
    tempDate.setMonth(0, 1 + ((4 - tempDate.getDay()) + 7) % 7); // First Thursday of year
  }
  return 1 + Math.ceil((firstThursday - tempDate) / 604800000); // weeks difference
}

// Parse plan file names to extract components
function parsePlanFile(filename) {
  const name = filename.replace('.md', '');
  const parts = name.split('_');
  
  // Year file: YYYY_00.md
  if (parts.length === 2 && parts[0].match(/^\d{4}$/) && parts[1] === '00') {
    return { year: parseInt(parts[0]), level: 'year' };
  }
  
  // Quarter file: YYYY_QQ_00.md
  if (parts.length === 3 && parts[0].match(/^\d{4}$/) && parts[1].match(/^Q[1-4]$/) && parts[2] === '00') {
    return { year: parseInt(parts[0]), quarter: parseInt(parts[1].substring(1)), level: 'quarter' };
  }
  
  // Month file: YYYY_QQ_MM_00.md
  if (parts.length === 4 && parts[0].match(/^\d{4}$/) && parts[1].match(/^Q[1-4]$/) && parts[2].match(/^\d{2}$/) && parts[3] === '00') {
    return { 
      year: parseInt(parts[0]), 
      quarter: parseInt(parts[1].substring(1)), 
      month: parseInt(parts[2]), 
      level: 'month' 
    };
  }
  
  // Week file: YYYY_QQ_MM_W##_00.md
  if (parts.length === 5 && parts[0].match(/^\d{4}$/) && parts[1].match(/^Q[1-4]$/) && parts[2].match(/^\d{2}$/) && parts[3].match(/^W\d{2}$/) && parts[4] === '00') {
    return { 
      year: parseInt(parts[0]), 
      quarter: parseInt(parts[1].substring(1)), 
      month: parseInt(parts[2]), 
      week: parseInt(parts[3].substring(1)), 
      level: 'week' 
    };
  }
  
  // Day file: YYYY_QQ_MM_W##_DD.md
  if (parts.length === 5 && parts[0].match(/^\d{4}$/) && parts[1].match(/^Q[1-4]$/) && parts[2].match(/^\d{2}$/) && parts[3].match(/^W\d{2}$/) && parts[4].match(/^\d{2}$/)) {
    return { 
      year: parseInt(parts[0]), 
      quarter: parseInt(parts[1].substring(1)), 
      month: parseInt(parts[2]), 
      week: parseInt(parts[3].substring(1)),
      day: parseInt(parts[4]), 
      level: 'day' 
    };
  }
  
  return null;
}

// Compare two plan files for sorting
function comparePlanFiles(a, b) {
  const aData = parsePlanFile(a);
  const bData = parsePlanFile(b);
  
  // Handle unparseable files
  if (!aData && !bData) return a.localeCompare(b);
  if (!aData) return 1;
  if (!bData) return -1;
  
  // Compare years
  if (aData.year !== bData.year) return aData.year - bData.year;
  
  // If one is year-level and other isn't, year comes first
  if (aData.level === 'year' && bData.level !== 'year') return -1;
  if (bData.level === 'year' && aData.level !== 'year') return 1;
  
  // Compare quarters
  if (aData.quarter !== bData.quarter) {
    if (aData.quarter === undefined) return -1;
    if (bData.quarter === undefined) return 1;
    return aData.quarter - bData.quarter;
  }
  
  // If one is quarter-level and other isn't, quarter comes first  
  if (aData.level === 'quarter' && bData.level !== 'quarter') return -1;
  if (bData.level === 'quarter' && aData.level !== 'quarter') return 1;
  
  // Compare months
  if (aData.month !== bData.month) {
    if (aData.month === undefined) return -1;
    if (bData.month === undefined) return 1;
    return aData.month - bData.month;
  }
  
  // If one is month-level and other isn't, month comes first
  if (aData.level === 'month' && bData.level !== 'month') return -1;
  if (bData.level === 'month' && aData.level !== 'month') return 1;
  
  // Compare weeks and days
  if (aData.level === 'week' && bData.level === 'week') {
    return aData.week - bData.week;
  }
  if (aData.level === 'week' && bData.level === 'day') return -1;
  if (aData.level === 'day' && bData.level === 'week') return 1;
  
  if (aData.level === 'day' && bData.level === 'day') {
    // First compare by week number, then by day
    if (aData.week !== bData.week) {
      return aData.week - bData.week;
    }
    return aData.day - bData.day;
  }
  
  return a.localeCompare(b);
}

// Get hierarchical level for plan files
function getPlanHierarchyLevel(filename) {
  const data = parsePlanFile(filename);
  if (!data) return 0;
  
  switch(data.level) {
    case 'year': return 0;
    case 'quarter': return 1;
    case 'month': return 2;
    case 'week': return 3;
    case 'day': return 4;
    default: return 0;
  }
}

// Directory listing
async function renderDirectory(dirPath, urlPath) {
  let items = await fs.readdir(dirPath, { withFileTypes: true });

  // Get current timer info
  const currentTimer = await getCurrentTimer();

  // Filter out hidden files and directories (starting with ".")
  items = items.filter(item => !item.name.startsWith('.'));
  
  // Special handling for plans directory
  if (urlPath === 'plans') {
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      // Just use alphabetical sorting - our naming scheme handles the hierarchy
      return a.name.localeCompare(b.name);
    });
  } else {
    // Default sort: directories first, then files
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
  }
  
  // Build breadcrumb items
  const breadcrumbParts = urlPath ? urlPath.split('/').filter(Boolean) : [];
  let breadcrumbHtml = '<li class="breadcrumb-item"><a href="/"><i class="fas fa-home"></i></a></li>';
  let currentPath = '';
  breadcrumbParts.forEach((part, index) => {
    currentPath += '/' + part;
    if (index === breadcrumbParts.length - 1) {
      breadcrumbHtml += `<li class="breadcrumb-item active" aria-current="page">${part}</li>`;
    } else {
      breadcrumbHtml += `<li class="breadcrumb-item"><a href="${currentPath}">${part}</a></li>`;
    }
  });

  let html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Vault: ${urlPath || '/'}</title>
      ${pageStyle}
    </head>
    <body>
      ${getNavbar()}

      <!-- Main content with chat -->
      <div class="container-fluid mt-3">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <!-- Time Tracking -->
        ${getTimerWidget(currentTimer)}

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-md-7 mb-3">
  `;

  // Special homepage content
  if (!urlPath) {
    // Use Eastern timezone for consistency with other scripts
    const easternTime = new Date(new Date().toLocaleString("en-US", {timeZone: "America/New_York"}));
    const today = easternTime;
    const year = today.getFullYear();
    const quarter = `Q${Math.floor(today.getMonth() / 3) + 1}`;
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const week = getWeekNumber(today);
    const day = String(today.getDate()).padStart(2, '0');
    
    // Check for today's plan
    const todayPlanFile = `${year}_${quarter}_${month}_W${String(week).padStart(2, '0')}_${day}.md`;
    const todayPlanPath = path.join(dirPath, 'plans', todayPlanFile);
    const todayPlanExists = await fs.access(todayPlanPath).then(() => true).catch(() => false);
    
    // Get task count for today from database cache
    let taskCount = 0;
    try {
      const db = getReadOnlyDatabase();
      const todayISO = today.toISOString().split('T')[0];

      // Query database for open tasks with due/scheduled dates for today or earlier
      const taskRows = db.prepare(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE status = 'open'
          AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
      `).get(todayISO, todayISO);

      taskCount = taskRows.count;
    } catch (error) {
      console.error('Error getting task count from database:', error);
    }
    
    // Check for other plan files
    const weekPlanFile = `${year}_${quarter}_${month}_W${String(week).padStart(2, '0')}_00.md`;
    const monthPlanFile = `${year}_${quarter}_${month}_00.md`;
    const quarterPlanFile = `${year}_${quarter}_00.md`;
    const yearPlanFile = `${year}_00.md`;
    
    const plansDir = path.join(dirPath, 'plans');
    const weekPlanExists = await fs.access(path.join(plansDir, weekPlanFile)).then(() => true).catch(() => false);
    const monthPlanExists = await fs.access(path.join(plansDir, monthPlanFile)).then(() => true).catch(() => false);
    const quarterPlanExists = await fs.access(path.join(plansDir, quarterPlanFile)).then(() => true).catch(() => false);
    const yearPlanExists = await fs.access(path.join(plansDir, yearPlanFile)).then(() => true).catch(() => false);
    
    // Add today's plan button if it exists
    if (todayPlanExists) {
      html += `
            <div class="card shadow-sm mb-3">
              <a href="/plans/${todayPlanFile}" class="list-group-item list-group-item-action bg-primary text-white">
                <div class="d-flex align-items-center ps-2">
                  <i class="fas fa-calendar-day me-2"></i>
                  <div>
                    <strong>Today's Plan</strong>
                    <br>
                    <small>${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</small>
                  </div>
                </div>
              </a>
            </div>`;
    }
    
    // Add Today's Tasks button (always show it)
    html += `
            <div class="card shadow-sm mb-3">
              <a href="/tasks/today.md" class="list-group-item list-group-item-action ${taskCount > 0 ? 'bg-warning' : 'bg-secondary'} text-white">
                <div class="d-flex align-items-center justify-content-between ps-2">
                  <div class="d-flex align-items-center">
                    <i class="fas fa-tasks me-2"></i>
                    <div>
                      <strong>Today's Tasks</strong>
                      <br>
                      <small>${taskCount > 0 ? `${taskCount} task${taskCount !== 1 ? 's' : ''} scheduled/due today` : 'No tasks scheduled for today'}</small>
                    </div>
                  </div>
                  ${taskCount > 0 ? `<span class="badge bg-light text-dark fs-6">${taskCount}</span>` : ''}
                </div>
              </a>
            </div>`;
    
    // Add Plans section (collapsed)
    html += `
            <div class="card shadow-sm mb-3">
              <div class="card-header" style="cursor: pointer;" onclick="toggleCollapse('plansSection')">
                <div class="d-flex justify-content-between align-items-center">
                  <span><i class="fas fa-calendar-alt me-2"></i> Plans</span>
                  <i class="fas fa-chevron-down" id="plansChevron"></i>
                </div>
              </div>
              <div class="collapse" id="plansSection">
                <div class="list-group list-group-flush">`;
    
    if (weekPlanExists) {
      html += `
                  <a href="/plans/${weekPlanFile}" class="list-group-item list-group-item-action">
                    <i class="fas fa-calendar-week text-info me-3"></i>
                    Week ${week}
                  </a>`;
    }
    if (monthPlanExists) {
      html += `
                  <a href="/plans/${monthPlanFile}" class="list-group-item list-group-item-action">
                    <i class="fas fa-calendar text-success me-3"></i>
                    ${today.toLocaleDateString('en-US', { month: 'long' })} ${year}
                  </a>`;
    }
    if (quarterPlanExists) {
      html += `
                  <a href="/plans/${quarterPlanFile}" class="list-group-item list-group-item-action">
                    <i class="fas fa-business-time text-warning me-3"></i>
                    Quarter ${quarter.slice(1)} - ${year}
                  </a>`;
    }
    if (yearPlanExists) {
      html += `
                  <a href="/plans/${yearPlanFile}" class="list-group-item list-group-item-action">
                    <i class="fas fa-calendar-check text-danger me-3"></i>
                    Year ${year}
                  </a>`;
    }
    
    html += `
                </div>
              </div>
            </div>`;
    
    // Add Recents section (collapsed) - placeholder for now
    html += `
            <div class="card shadow-sm mb-3">
              <div class="card-header" style="cursor: pointer;" onclick="toggleCollapse('recentsSection')">
                <div class="d-flex justify-content-between align-items-center">
                  <span><i class="fas fa-history me-2"></i> Recent Pages</span>
                  <i class="fas fa-chevron-down" id="recentsChevron"></i>
                </div>
              </div>
              <div class="collapse" id="recentsSection">
                <div class="list-group list-group-flush" id="recentsList">
                  <div class="list-group-item text-muted">
                    <small>Recent pages will appear here</small>
                  </div>
                </div>
              </div>
            </div>`;
  }
  
  html += `
            <div class="card shadow-sm h-100">
              <div class="list-group list-group-flush">
  `;
  
  // Add parent directory link if not at root
  if (urlPath) {
    const parentPath = path.dirname(urlPath);
    html += `
      <a href="/${parentPath === '.' ? '' : parentPath}" class="list-group-item list-group-item-action">
        <i class="fas fa-level-up-alt text-muted me-3"></i>
        <span class="text-muted">..</span>
      </a>`;
  }
  
  // Add directories first
  for (const item of items) {
    if (item.isDirectory()) {
      const itemPath = urlPath ? `${urlPath}/${item.name}` : item.name;
      html += `
        <a href="/${itemPath}" class="list-group-item list-group-item-action">
          <i class="fas fa-folder text-warning me-3"></i>
          <strong>${item.name}/</strong>
        </a>`;
    }
  }

  // Batch fetch metadata for all markdown files (PERFORMANCE OPTIMIZATION)
  const mdFiles = items.filter(item => !item.isDirectory() && item.name.endsWith('.md'));
  const mdFilePaths = mdFiles.map(item => path.join(dirPath, item.name));
  const mdMetadata = await markdownCache.getBatchMetadata(mdFilePaths);
  const mdTitleMap = new Map(mdMetadata.map(md => [md.path, md.title]));

  // Then add files
  for (const item of items) {
    if (!item.isDirectory()) {
      const itemPath = urlPath ? `${urlPath}/${item.name}` : item.name;
      const fullFilePath = path.join(dirPath, item.name);
      let icon = item.name.endsWith('.md') ? 'fa-file-alt text-info' : 'fa-file text-secondary';

      // Calculate indentation and special icons for plans directory
      let indentStyle = '';
      if (urlPath === 'plans') {
        const level = getPlanHierarchyLevel(item.name);
        indentStyle = `padding-left: ${1.5 + level * 1.5}rem !important;`;

        // Use specific icons for each plan level
        const planData = parsePlanFile(item.name);
        if (planData) {
          switch(planData.level) {
            case 'year':
              icon = 'fa-calendar-check text-danger';
              break;
            case 'quarter':
              icon = 'fa-business-time text-warning';
              break;
            case 'month':
              icon = 'fa-calendar text-success';
              break;
            case 'week':
              icon = 'fa-calendar-week text-info';
              break;
            case 'day':
              icon = 'fa-calendar-day text-primary';
              break;
          }
        }
      }

      // For markdown files, get title from batch-fetched metadata
      let displayContent;
      if (item.name.endsWith('.md')) {
        const title = mdTitleMap.get(fullFilePath);
        if (title) {
          // Show title with filename as subtitle, icon inline
          displayContent = `
            <div class="d-flex align-items-center">
              <i class="fas ${icon} me-3"></i>
              <div>
                <strong>${title}</strong>
                <br>
                <small class="text-muted">${item.name}</small>
              </div>
            </div>`;
        } else {
          // No title found, show filename with icon inline
          displayContent = `
            <div class="d-flex align-items-center">
              <i class="fas ${icon} me-3"></i>
              <span>${item.name}</span>
            </div>`;
        }
      } else {
        // Non-markdown files
        displayContent = `
          <div class="d-flex align-items-center">
            <i class="fas ${icon} me-3"></i>
            <span>${item.name}</span>
          </div>`;
      }

      html += `
        <a href="/${itemPath}" class="list-group-item list-group-item-action" style="${indentStyle}">
          ${displayContent}
        </a>`;
    }
  }
  
  html += `
          </div>
        </div>
      </div>

    <!-- Chat column -->
    <div class="col-12 col-md-5 mb-3">
      ${getAIAssistantPanel('Ask questions about this directory and its contents')}
    </div>
  </div>

      ${getFloatingToggleBtn()}

      ${pageScriptsWithMarked}

      <script>
        // Page-specific data for AI context
        const directoryPath = '${urlPath || '/'}';
        const directoryContents = ${JSON.stringify(items.map(item => ({
          name: item.name,
          type: item.isDirectory() ? 'directory' : 'file'
        })))};
        
        // Chat functionality
        checkChatVersion(); // Page will reload if version changed

        let chatHistory = [];
        let inputHistory = JSON.parse(localStorage.getItem('inputHistory') || '[]');
        let historyIndex = -1;
        const chatStorageKey = 'chatHistory_dir_${urlPath || 'root'}';
        const chatApiPath = 'dir_${urlPath || 'root'}';

        // Load existing chat messages (from server first, then localStorage fallback)
        async function loadChatHistory() {
          const chatMessages = document.getElementById('chatMessages');

          // Try to load from server first
          try {
            const response = await fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`);
            if (response.ok) {
              const data = await response.json();
              if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                // Also update localStorage as backup
                localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
              }
            }
          } catch (e) {
            console.log('Failed to load chat from server, falling back to localStorage');
          }

          // Fall back to localStorage if no server data
          if (chatHistory.length === 0) {
            chatHistory = JSON.parse(localStorage.getItem(chatStorageKey) || '[]');
          }

          if (chatHistory.length > 0) {
            chatMessages.innerHTML = '';
            chatHistory.forEach(msg => {
              addChatBubble(msg.content, msg.role, false);
            });
          }
        }

        // Save conversation to server
        async function saveConversationToServer() {
          try {
            await fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: chatHistory })
            });
          } catch (e) {
            console.log('Failed to save conversation to server');
          }
        }
        
        // Add a chat bubble to the interface
        function addChatBubble(message, role, save = true) {
          const chatMessages = document.getElementById('chatMessages');
          const bubble = document.createElement('div');
          bubble.className = \`chat-bubble \${role}\`;
          
          const timestamp = new Date().toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
          });
          
          // Render markdown using marked with external link renderer
          const renderedContent = marked.parse(message, { renderer: createExternalLinkRenderer() });
          
          let bubbleHtml = \`
            <div class="bubble-content">
              <small class="d-block chat-timestamp">
                \${role === 'user' ? 'You' : 'AI'} · \${timestamp}
              </small>
              <div class="markdown-content">\${renderedContent}</div>
            </div>
          \`;
          
          bubble.innerHTML = bubbleHtml;
          chatMessages.appendChild(bubble);
          chatMessages.scrollTop = chatMessages.scrollHeight;
          
          if (save) {
            chatHistory.push({
              role: role,
              content: message,
              timestamp: new Date().toISOString()
            });
            localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
            saveConversationToServer();
          }
        }

        // Send message to AI
        async function sendMessage() {
          const input = document.getElementById('chatInput');
          const message = input.value.trim();

          if (!message) return;

          // Handle /clear command
          if (message === '/clear') {
            chatHistory = [];
            localStorage.removeItem(chatStorageKey);
            // Also clear on server
            fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`, { method: 'DELETE' }).catch(() => {});
            document.getElementById('chatMessages').innerHTML = \`
              <div class="text-center text-muted p-3">
                <small>Conversation cleared. Start fresh!</small>
              </div>
            \`;
            input.value = '';
            return;
          }
          
          // Add to input history
          inputHistory.unshift(message);
          inputHistory = inputHistory.slice(0, 50);
          localStorage.setItem('inputHistory', JSON.stringify(inputHistory));
          historyIndex = -1;
          
          // Add user message
          addChatBubble(message, 'user');
          input.value = '';
          
          // Show typing indicator
          const typingIndicator = document.createElement('div');
          typingIndicator.className = 'chat-bubble assistant typing-indicator';
          typingIndicator.innerHTML = \`
            <div class="bubble-content">
              <small class="d-block chat-timestamp">AI · Thinking...</small>
              <div class="spinner-border spinner-border-sm text-secondary" role="status">
                <span class="visually-hidden">Loading...</span>
              </div>
            </div>
          \`;
          document.getElementById('chatMessages').appendChild(typingIndicator);
          
          try {
            // Create directory context for AI
            const directoryContext = \`Directory: \${directoryPath}
Contents:
\${directoryContents.map(item => \`- \${item.name}\${item.type === 'directory' ? '/' : ''}\`).join('\\n')}\`;
            
            const response = await fetch(\`/ai-chat-directory/\${directoryPath}\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: message,
                history: chatHistory,
                directoryContext: directoryContext
              })
            });
            
            if (!response.ok) throw new Error('Failed to get AI response');
            
            const data = await response.json();
            
            // Remove typing indicator
            typingIndicator.remove();
            
            // Add AI response
            addChatBubble(data.response, 'assistant');
            
          } catch (error) {
            console.error('Error sending message:', error);
            typingIndicator.remove();
            addChatBubble('Sorry, I encountered an error. Please try again.', 'assistant');
          }
        }
        
        // Handle input history with arrow keys
        document.getElementById('chatInput').addEventListener('keydown', function(e) {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex < inputHistory.length - 1) {
              historyIndex++;
              this.value = inputHistory[historyIndex];
            }
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
              historyIndex--;
              this.value = inputHistory[historyIndex];
            } else if (historyIndex === 0) {
              historyIndex = -1;
              this.value = '';
            }
          }
        });
        
        // Load chat history on page load
        loadChatHistory();
        
        // Toggle collapse sections
        window.toggleCollapse = function(sectionId) {
          const section = document.getElementById(sectionId);
          const chevron = document.getElementById(sectionId.replace('Section', 'Chevron'));
          
          if (section.classList.contains('show')) {
            section.classList.remove('show');
            chevron.classList.remove('fa-chevron-up');
            chevron.classList.add('fa-chevron-down');
          } else {
            section.classList.add('show');
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-up');
          }
        }
        
        // Track page visits for recents
        const currentPath = window.location.pathname;
        if (currentPath !== '/' && currentPath !== '') {
          let recentPages = JSON.parse(localStorage.getItem('recentPages') || '[]');
          
          // Remove current page if it exists in the list
          recentPages = recentPages.filter(page => page.path !== currentPath);
          
          // Add current page to the beginning
          // For directory pages, clean up the title
          let pageTitle = document.title;
          if (pageTitle.startsWith('Vault: ')) {
            pageTitle = pageTitle.replace('Vault: ', '');
            // If it's just '/', show 'Home'
            if (pageTitle === '/') {
              pageTitle = 'Home';
            }
          }
          recentPages.unshift({
            path: currentPath,
            title: pageTitle,
            timestamp: new Date().toISOString()
          });
          
          // Keep only the 10 most recent
          recentPages = recentPages.slice(0, 10);
          
          localStorage.setItem('recentPages', JSON.stringify(recentPages));
        }
        
        // Load recent pages if on homepage
        if (window.location.pathname === '/' || window.location.pathname === '') {
          const recentPages = JSON.parse(localStorage.getItem('recentPages') || '[]');
          const recentsList = document.getElementById('recentsList');
          
          if (recentsList && recentPages.length > 0) {
            let recentsHtml = '';
            recentPages.forEach(page => {
              const icon = page.path.endsWith('.md') ? 'fa-file-alt text-info' : 
                           page.path.includes('/') ? 'fa-folder text-warning' : 
                           'fa-file text-secondary';
              const timeAgo = getTimeAgo(new Date(page.timestamp));
              recentsHtml += \`
                <a href="\${page.path}" class="list-group-item list-group-item-action">
                  <div class="d-flex justify-content-between align-items-center">
                    <div>
                      <i class="fas \${icon} me-2"></i>
                      <span>\${page.title}</span>
                    </div>
                    <small class="text-muted">\${timeAgo}</small>
                  </div>
                </a>
              \`;
            });
            recentsList.innerHTML = recentsHtml;
          }
        }
      </script>
    </body>
    </html>
  `;
  
  return html;
}

// Editor rendering
async function renderEditor(filePath, urlPath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const fileName = path.basename(urlPath);
  
  // Build breadcrumb
  const breadcrumbParts = urlPath ? urlPath.split('/').filter(Boolean) : [];
  let breadcrumbHtml = '<li class="breadcrumb-item"><a href="/"><i class="fas fa-home"></i></a></li>';
  let currentPath = '';
  breadcrumbParts.forEach((part, index) => {
    currentPath += '/' + part;
    if (index === breadcrumbParts.length - 1) {
      breadcrumbHtml += `<li class="breadcrumb-item active" aria-current="page">Editing: ${part}</li>`;
    } else {
      breadcrumbHtml += `<li class="breadcrumb-item"><a href="${currentPath}">${part}</a></li>`;
    }
  });
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Edit: ${fileName}</title>
      ${pageStyle}
    </head>
    <body>
      ${getNavbar(`Editing: ${fileName}`, 'fa-edit')}

      <!-- Main content -->
      <div class="container mt-4">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <!-- Editor -->
        <div class="card shadow-sm">
          <div class="editor-toolbar">
            <div class="row align-items-center">
              <div class="col">
                <span class="text-muted">
                  <i class="fas fa-keyboard me-2"></i>
                  Markdown Editor
                </span>
              </div>
              <div class="col-auto">
                <span id="save-status" class="text-muted small me-3"></span>
                <button onclick="saveFile()" class="btn btn-success btn-sm me-2">
                  <i class="fas fa-save me-1"></i>Save
                </button>
                <a href="/${urlPath}" class="btn btn-light btn-sm">
                  <i class="fas fa-times me-1"></i>Close
                </a>
              </div>
            </div>
          </div>
          <div class="card-body p-0">
            <div class="editor-container">
              <textarea id="editor" class="form-control border-0">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            </div>
          </div>
        </div>
      </div>

      ${pageScripts}

      <script>
        // Page-specific functions (performSearch is in common.js)
        function saveFile() {
          const content = document.getElementById('editor').value;
          const saveStatus = document.getElementById('save-status');
          
          saveStatus.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Saving...';
          saveStatus.className = 'text-primary small me-3';
          
          fetch('/save/${urlPath}', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: content })
          })
          .then(response => {
            if (response.ok) {
              saveStatus.innerHTML = '<i class="fas fa-check me-1"></i>Saved successfully!';
              saveStatus.className = 'text-success small me-3';
              setTimeout(() => {
                saveStatus.innerHTML = '';
              }, 3000);
            } else {
              throw new Error('Save failed');
            }
          })
          .catch(error => {
            saveStatus.innerHTML = '<i class="fas fa-exclamation-triangle me-1"></i>Save failed!';
            saveStatus.className = 'text-danger small me-3';
          });
        }
        
        // Auto-save on Ctrl+S / Cmd+S
        document.addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
          }
        });
        
        // Focus the editor when page loads
        document.getElementById('editor').focus();
        
        // Add Tab key support in textarea
        document.getElementById('editor').addEventListener('keydown', function(e) {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = this.selectionStart;
            const end = this.selectionEnd;
            const value = this.value;
            this.value = value.substring(0, start) + '  ' + value.substring(end);
            this.selectionStart = this.selectionEnd = start + 2;
          }
        });
      </script>
    </body>
    </html>
  `;
}

// Emoji to Font Awesome icon mapping
const emojiToFontAwesome = {
  // Common emojis
  '✅': '<i class="fas fa-check-circle text-success"></i>',
  '❌': '<i class="fas fa-times-circle text-danger"></i>',
  '⚠️': '<i class="fas fa-exclamation-triangle text-warning"></i>',
  '💡': '<i class="fas fa-lightbulb text-warning"></i>',
  '📝': '<i class="fas fa-edit text-info"></i>',
  '📚': '<i class="fas fa-book text-info"></i>',
  '📖': '<i class="fas fa-book-open text-info"></i>',
  '📊': '<i class="fas fa-chart-bar text-primary"></i>',
  '📈': '<i class="fas fa-chart-line text-success"></i>',
  '📉': '<i class="fas fa-chart-line text-danger"></i>',
  '🎯': '<i class="fas fa-bullseye text-danger"></i>',
  '🔍': '<i class="fas fa-search text-secondary"></i>',
  '🔎': '<i class="fas fa-search-plus text-secondary"></i>',
  '💭': '<i class="fas fa-comment-dots text-info"></i>',
  '💬': '<i class="fas fa-comments text-info"></i>',
  '📅': '<i class="fas fa-calendar-alt text-primary"></i>',
  '📆': '<i class="fas fa-calendar text-primary"></i>',
  '⏰': '<i class="fas fa-clock text-warning"></i>',
  '🕐': '<i class="fas fa-clock text-secondary"></i>',
  '📧': '<i class="fas fa-envelope text-info"></i>',
  '📮': '<i class="fas fa-envelope-open text-info"></i>',
  '📞': '<i class="fas fa-phone text-success"></i>',
  '🔔': '<i class="fas fa-bell text-warning"></i>',
  '🔕': '<i class="fas fa-bell-slash text-secondary"></i>',
  '⭐': '<i class="fas fa-star text-warning"></i>',
  '🌟': '<i class="fas fa-star text-warning"></i>',
  '❤️': '<i class="fas fa-heart text-danger"></i>',
  '💔': '<i class="fas fa-heart-broken text-danger"></i>',
  '🔥': '<i class="fas fa-fire text-danger"></i>',
  '🚀': '<i class="fas fa-rocket text-primary"></i>',
  '💰': '<i class="fas fa-dollar-sign text-success"></i>',
  '💵': '<i class="fas fa-money-bill text-success"></i>',
  '🏠': '<i class="fas fa-home text-primary"></i>',
  '🏢': '<i class="fas fa-building text-secondary"></i>',
  '🔑': '<i class="fas fa-key text-warning"></i>',
  '🔒': '<i class="fas fa-lock text-secondary"></i>',
  '🔓': '<i class="fas fa-lock-open text-warning"></i>',
  '🔗': '<i class="fas fa-link text-info"></i>',
  '📎': '<i class="fas fa-paperclip text-secondary"></i>',
  '✏️': '<i class="fas fa-pencil-alt text-secondary"></i>',
  '🖊️': '<i class="fas fa-pen text-secondary"></i>',
  '📁': '<i class="fas fa-folder text-warning"></i>',
  '📂': '<i class="fas fa-folder-open text-warning"></i>',
  '💾': '<i class="fas fa-save text-primary"></i>',
  '🗑️': '<i class="fas fa-trash text-danger"></i>',
  '⚙️': '<i class="fas fa-cog text-secondary"></i>',
  '🔧': '<i class="fas fa-wrench text-secondary"></i>',
  '🔨': '<i class="fas fa-hammer text-secondary"></i>',
  '🛠️': '<i class="fas fa-tools text-secondary"></i>',
  '🐛': '<i class="fas fa-bug text-danger"></i>',
  '💻': '<i class="fas fa-laptop text-primary"></i>',
  '🖥️': '<i class="fas fa-desktop text-primary"></i>',
  '📱': '<i class="fas fa-mobile-alt text-primary"></i>',
  '☁️': '<i class="fas fa-cloud text-info"></i>',
  '🌐': '<i class="fas fa-globe text-primary"></i>',
  '📦': '<i class="fas fa-box text-warning"></i>',
  '🎁': '<i class="fas fa-gift text-danger"></i>',
  '🏆': '<i class="fas fa-trophy text-warning"></i>',
  '🥇': '<i class="fas fa-medal text-warning"></i>',
  '🎓': '<i class="fas fa-graduation-cap text-primary"></i>',
  '💊': '<i class="fas fa-pills text-danger"></i>',
  '🏥': '<i class="fas fa-hospital text-danger"></i>',
  '✈️': '<i class="fas fa-plane text-info"></i>',
  '🚗': '<i class="fas fa-car text-secondary"></i>',
  '🚌': '<i class="fas fa-bus text-secondary"></i>',
  '🚂': '<i class="fas fa-train text-secondary"></i>',
  '⚡': '<i class="fas fa-bolt text-warning"></i>',
  '☕': '<i class="fas fa-coffee text-brown"></i>',
  '🍕': '<i class="fas fa-pizza-slice text-warning"></i>',
  '🎵': '<i class="fas fa-music text-info"></i>',
  '🎬': '<i class="fas fa-film text-secondary"></i>',
  '📷': '<i class="fas fa-camera text-secondary"></i>',
  '🎮': '<i class="fas fa-gamepad text-primary"></i>',
  '⚽': '<i class="fas fa-futbol text-success"></i>',
  '🏀': '<i class="fas fa-basketball-ball text-warning"></i>',
  '⚾': '<i class="fas fa-baseball-ball text-danger"></i>',
  '🎾': '<i class="fas fa-table-tennis text-success"></i>',
  '🏃': '<i class="fas fa-running text-primary"></i>',
  '🚴': '<i class="fas fa-biking text-primary"></i>',
  '👍': '<i class="fas fa-thumbs-up text-success"></i>',
  '👎': '<i class="fas fa-thumbs-down text-danger"></i>',
  '👏': '<i class="fas fa-hands-clapping text-success"></i>',
  '🙏': '<i class="fas fa-praying-hands text-info"></i>',
  '👁️': '<i class="fas fa-eye text-info"></i>',
  '👀': '<i class="fas fa-eye text-info"></i>',
  '🧠': '<i class="fas fa-brain text-pink"></i>',
  '💪': '<i class="fas fa-dumbbell text-primary"></i>',
  '🌳': '<i class="fas fa-tree text-success"></i>',
  '🌲': '<i class="fas fa-tree text-success"></i>',
  '🌱': '<i class="fas fa-seedling text-success"></i>',
  '🌸': '<i class="fas fa-spa text-pink"></i>',
  '☀️': '<i class="fas fa-sun text-warning"></i>',
  '🌙': '<i class="fas fa-moon text-info"></i>',
  '⛅': '<i class="fas fa-cloud-sun text-info"></i>',
  '☔': '<i class="fas fa-umbrella text-info"></i>',
  '❄️': '<i class="fas fa-snowflake text-info"></i>',
  '🌡️': '<i class="fas fa-thermometer-half text-danger"></i>',
  '💧': '<i class="fas fa-tint text-info"></i>',
  '🔴': '<i class="fas fa-circle text-danger"></i>',
  '🟢': '<i class="fas fa-circle text-success"></i>',
  '🔵': '<i class="fas fa-circle text-primary"></i>',
  '🟡': '<i class="fas fa-circle text-warning"></i>',
  '⚫': '<i class="fas fa-circle text-dark"></i>',
  '⚪': '<i class="fas fa-circle text-secondary"></i>',
  '▶️': '<i class="fas fa-play text-success"></i>',
  '⏸️': '<i class="fas fa-pause text-warning"></i>',
  '⏹️': '<i class="fas fa-stop text-danger"></i>',
  '⏪': '<i class="fas fa-backward text-info"></i>',
  '⏩': '<i class="fas fa-forward text-info"></i>',
  '🔄': '<i class="fas fa-sync text-info"></i>',
  '♻️': '<i class="fas fa-recycle text-success"></i>',
  '➕': '<i class="fas fa-plus text-success"></i>',
  '➖': '<i class="fas fa-minus text-danger"></i>',
  '✖️': '<i class="fas fa-times text-danger"></i>',
  '❓': '<i class="fas fa-question-circle text-info"></i>',
  '❗': '<i class="fas fa-exclamation-circle text-danger"></i>',
  '💤': '<i class="fas fa-bed text-info"></i>',
  '🛏️': '<i class="fas fa-bed text-info"></i>',
  '🚿': '<i class="fas fa-shower text-info"></i>',
  '🚽': '<i class="fas fa-toilet text-secondary"></i>',
  '🍴': '<i class="fas fa-utensils text-secondary"></i>',
  '🥤': '<i class="fas fa-glass-whiskey text-info"></i>',
  '🍺': '<i class="fas fa-beer text-warning"></i>',
  '🍷': '<i class="fas fa-wine-glass-alt text-danger"></i>',
  '🎂': '<i class="fas fa-birthday-cake text-warning"></i>',
  '🎉': '<i class="fas fa-glass-cheers text-warning"></i>',
  '🎊': '<i class="fas fa-glass-cheers text-warning"></i>',
  '🎈': '<i class="fas fa-gift text-danger"></i>',
  '📍': '<i class="fas fa-map-marker-alt text-danger"></i>',
  '🗺️': '<i class="fas fa-map text-info"></i>',
  '🧭': '<i class="fas fa-compass text-info"></i>',
  '🚦': '<i class="fas fa-traffic-light text-warning"></i>',
  '🚧': '<i class="fas fa-exclamation-triangle text-warning"></i>',
  '⛔': '<i class="fas fa-ban text-danger"></i>',
  '🚫': '<i class="fas fa-ban text-danger"></i>',
  '🚭': '<i class="fas fa-smoking-ban text-danger"></i>',
  '♿': '<i class="fas fa-wheelchair text-info"></i>',
  '🚻': '<i class="fas fa-restroom text-info"></i>',
  '🚹': '<i class="fas fa-male text-info"></i>',
  '🚺': '<i class="fas fa-female text-info"></i>',
  '🚼': '<i class="fas fa-baby text-info"></i>',
  '📢': '<i class="fas fa-bullhorn text-warning"></i>',
  '📣': '<i class="fas fa-megaphone text-warning"></i>',
  '📡': '<i class="fas fa-satellite-dish text-secondary"></i>',
  '📻': '<i class="fas fa-broadcast-tower text-secondary"></i>',
  '📹': '<i class="fas fa-video text-danger"></i>',
  '🎥': '<i class="fas fa-video text-danger"></i>',
  '🎤': '<i class="fas fa-microphone text-secondary"></i>',
  '🎧': '<i class="fas fa-headphones text-secondary"></i>',
  '🎸': '<i class="fas fa-guitar text-warning"></i>',
  '🥁': '<i class="fas fa-drum text-secondary"></i>',
  '🎹': '<i class="fas fa-keyboard text-secondary"></i>',
  '🎺': '<i class="fas fa-trumpet text-warning"></i>',
  '🎻': '<i class="fas fa-violin text-warning"></i>',
  '🎭': '<i class="fas fa-theater-masks text-warning"></i>',
  '🎨': '<i class="fas fa-palette text-danger"></i>',
  '🖼️': '<i class="fas fa-image text-info"></i>',
  '🖌️': '<i class="fas fa-paint-brush text-danger"></i>',
  '✂️': '<i class="fas fa-cut text-secondary"></i>',
  '📏': '<i class="fas fa-ruler text-secondary"></i>',
  '📐': '<i class="fas fa-ruler-combined text-secondary"></i>',
  '🔬': '<i class="fas fa-microscope text-info"></i>',
  '🔭': '<i class="fas fa-satellite text-info"></i>',
  '💉': '<i class="fas fa-syringe text-danger"></i>',
  '🩺': '<i class="fas fa-stethoscope text-info"></i>',
  '🩹': '<i class="fas fa-band-aid text-warning"></i>',
  '🧬': '<i class="fas fa-dna text-info"></i>',
  '🧪': '<i class="fas fa-vial text-info"></i>',
  '🧫': '<i class="fas fa-bacteria text-success"></i>',
  '🧯': '<i class="fas fa-fire-extinguisher text-danger"></i>',
  '🪜': '<i class="fas fa-ladder text-secondary"></i>',
  '🧲': '<i class="fas fa-magnet text-danger"></i>',
  '🔩': '<i class="fas fa-screwdriver text-secondary"></i>',
  '⚖️': '<i class="fas fa-balance-scale text-secondary"></i>',
  '🧮': '<i class="fas fa-calculator text-secondary"></i>',
  '📌': '<i class="fas fa-thumbtack text-danger"></i>',
  '📋': '<i class="fas fa-clipboard text-secondary"></i>',
  '📄': '<i class="fas fa-file-alt text-secondary"></i>',
  '📃': '<i class="fas fa-file text-secondary"></i>',
  '📑': '<i class="fas fa-bookmark text-warning"></i>',
  '🔖': '<i class="fas fa-bookmark text-warning"></i>',
  '🏷️': '<i class="fas fa-tag text-info"></i>',
  '💳': '<i class="fas fa-credit-card text-primary"></i>',
  '🧾': '<i class="fas fa-receipt text-secondary"></i>',
  '📊': '<i class="fas fa-chart-pie text-primary"></i>',
  '📈': '<i class="fas fa-chart-area text-success"></i>',
  '📉': '<i class="fas fa-chart-line text-danger"></i>',
  '🗂️': '<i class="fas fa-folder-tree text-warning"></i>',
  '🗄️': '<i class="fas fa-archive text-secondary"></i>',
  '🗃️': '<i class="fas fa-box-archive text-secondary"></i>',
  '📥': '<i class="fas fa-inbox text-info"></i>',
  '📤': '<i class="fas fa-share text-info"></i>',
  '📨': '<i class="fas fa-envelope-open-text text-info"></i>',
  '📩': '<i class="fas fa-envelope text-info"></i>',
  '📬': '<i class="fas fa-mailbox text-secondary"></i>',
  '📭': '<i class="fas fa-mailbox text-secondary"></i>',
  '🗳️': '<i class="fas fa-box-ballot text-primary"></i>',
  '✉️': '<i class="fas fa-envelope text-info"></i>',
  '📜': '<i class="fas fa-scroll text-warning"></i>',
  '📰': '<i class="fas fa-newspaper text-secondary"></i>',
  '🗞️': '<i class="fas fa-newspaper text-secondary"></i>',
  '📖': '<i class="fas fa-book-open text-info"></i>',
  '📕': '<i class="fas fa-book text-danger"></i>',
  '📗': '<i class="fas fa-book text-success"></i>',
  '📘': '<i class="fas fa-book text-info"></i>',
  '📙': '<i class="fas fa-book text-warning"></i>',
  '📓': '<i class="fas fa-book text-secondary"></i>',
  '📒': '<i class="fas fa-book text-warning"></i>',
  '📔': '<i class="fas fa-book text-secondary"></i>',
  '🔏': '<i class="fas fa-lock text-secondary"></i>',
  '🔐': '<i class="fas fa-lock text-warning"></i>',
  '🔒': '<i class="fas fa-lock text-secondary"></i>',
  '🔓': '<i class="fas fa-lock-open text-warning"></i>',
  '🛡️': '<i class="fas fa-shield-alt text-primary"></i>',
  '🗝️': '<i class="fas fa-key text-warning"></i>',
  '🔨': '<i class="fas fa-gavel text-secondary"></i>',
  '⛏️': '<i class="fas fa-hammer text-secondary"></i>',
  '🪓': '<i class="fas fa-axe text-secondary"></i>',
  '🧰': '<i class="fas fa-toolbox text-secondary"></i>',
  '🧱': '<i class="fas fa-cube text-danger"></i>',
  '🪨': '<i class="fas fa-mountain text-secondary"></i>',
  '🪵': '<i class="fas fa-tree text-brown"></i>',
  '🛢️': '<i class="fas fa-oil-can text-dark"></i>',
  '⛽': '<i class="fas fa-gas-pump text-danger"></i>',
  '🚨': '<i class="fas fa-siren text-danger"></i>',
  '🚥': '<i class="fas fa-traffic-light text-warning"></i>',
  '🚦': '<i class="fas fa-traffic-light text-warning"></i>',
  '🛑': '<i class="fas fa-stop-sign text-danger"></i>',
  '🚧': '<i class="fas fa-construction text-warning"></i>'
};

// Function to convert emojis to Font Awesome icons in HTML
function convertEmojisToIcons(html) {
  let convertedHtml = html;
  
  // Sort emojis by length (longer emojis first to avoid partial matches)
  const sortedEmojis = Object.keys(emojiToFontAwesome).sort((a, b) => b.length - a.length);
  
  for (const emoji of sortedEmojis) {
    const icon = emojiToFontAwesome[emoji];
    // Use a global replace with proper escaping
    const emojiRegex = new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    convertedHtml = convertedHtml.replace(emojiRegex, icon);
  }
  
  return convertedHtml;
}

// Cache management functions
function cleanupCache() {
  // Remove expired entries
  const now = Date.now();
  for (const [key, value] of renderCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      renderCache.delete(key);
      fileStatsCache.delete(key);
    }
  }
  
  // If still too large, remove oldest entries
  if (renderCache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(renderCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, entries.length - CACHE_MAX_SIZE);
    for (const [key] of toRemove) {
      renderCache.delete(key);
      fileStatsCache.delete(key);
    }
  }
}

// Get cached render or generate new one
async function getCachedRender(filePath, urlPath) {
  try {
    const stats = await fs.stat(filePath);
    const mtime = stats.mtime.getTime();
    const size = stats.size;
    
    // Create cache key from filepath
    const cacheKey = filePath;
    
    // Check if we have a cached version
    const cached = renderCache.get(cacheKey);
    const cachedStats = fileStatsCache.get(cacheKey);
    
    // Return cached version if file hasn't changed
    if (cached && cachedStats && 
        cachedStats.mtime === mtime && 
        cachedStats.size === size) {
      cached.hits = (cached.hits || 0) + 1;
      debug(`[CACHE HIT] ${urlPath} (hits: ${cached.hits})`);
      return cached.html;
    }

    // Render and cache the result
    debug(`[CACHE MISS] ${urlPath} - rendering...`);
    const rendered = await renderMarkdownUncached(filePath, urlPath);
    
    // Store in cache
    renderCache.set(cacheKey, {
      html: rendered,
      timestamp: Date.now(),
      hits: 0
    });
    
    fileStatsCache.set(cacheKey, {
      mtime: mtime,
      size: size
    });
    
    // Cleanup old entries periodically
    if (Math.random() < 0.1) { // 10% chance to cleanup
      cleanupCache();
    }
    
    return rendered;
  } catch (error) {
    console.error(`Error in getCachedRender for ${filePath}:`, error);
    // Fall back to uncached rendering
    return renderMarkdownUncached(filePath, urlPath);
  }
}

// Create a marked renderer that opens external links in new tabs
function createExternalLinkRenderer() {
  const renderer = new marked.Renderer();
  const originalLinkRenderer = renderer.link.bind(renderer);
  renderer.link = function(href, title, text) {
    // Check if the link is external (starts with http:// or https://)
    const isExternal = /^https?:\/\//.test(href);
    let link = originalLinkRenderer(href, title, text);
    
    if (isExternal) {
      // Add target="_blank" and rel="noopener noreferrer" for external links
      link = link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
    }
    
    return link;
  };
  return renderer;
}

// Generate table of contents from parsed headings (using marked-gfm-heading-id)
function generateTableOfContents() {
  // Get headings from the most recent marked.parse() call
  const headings = getHeadingList();

  // Filter to h2-h6 only (skip h1 which is usually the title)
  const tocHeadings = headings.filter(h => h.level >= 2 && h.level <= 6);

  if (tocHeadings.length === 0) return '';

  // Generate TOC HTML for header
  let tocHtml = '';
  tocHtml += '<details class="toc-header">\n';
  tocHtml += '<summary class="text-muted small" style="cursor: pointer; user-select: none;"><i class="fas fa-list me-1"></i>Table of Contents</summary>\n';
  tocHtml += '<div class="toc-links mt-1">\n';
  tocHtml += '<ul class="list-unstyled small mb-0">\n';

  tocHeadings.forEach(heading => {
    const indent = (heading.level - 2) * 15; // Start from h2, each level adds 15px
    tocHtml += `<li style="margin-left: ${indent}px; margin-bottom: 0.15rem; line-height: 1.3;">`;
    tocHtml += `<a href="#${heading.id}">`;
    tocHtml += heading.text;
    tocHtml += '</a></li>\n';
  });

  tocHtml += '</ul>\n';
  tocHtml += '</div>\n';
  tocHtml += '</details>\n';

  return tocHtml;
}

// The replaceTagsWithEmojis function is now imported from tag-emoji-mappings.js

// Parse YAML frontmatter from markdown content
function parseFrontmatter(content) {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { properties: null, contentWithoutFrontmatter: content };
  }

  try {
    const properties = yaml.load(match[1]);
    const contentWithoutFrontmatter = content.replace(frontmatterRegex, '');
    return { properties, contentWithoutFrontmatter };
  } catch (error) {
    // Just log the message, not the full error object (too verbose for vault scanning)
    console.error('Error parsing YAML frontmatter:', error.message || error);
    return { properties: null, contentWithoutFrontmatter: content };
  }
}

// Render properties as a nice HTML card
function renderProperties(properties) {
  if (!properties || Object.keys(properties).length === 0) {
    return '';
  }

  // Helper to format property values
  function formatValue(value, key) {
    // Handle cover images specially
    if (key === 'cover_image' && typeof value === 'string' && value.match(/^https?:\/\//)) {
      return `<img src="${value}" alt="Cover" class="img-fluid rounded mb-2" style="max-height: 200px; object-fit: cover;">`;
    }

    // Handle URLs
    if (typeof value === 'string' && value.match(/^https?:\/\//)) {
      return `<a href="${value}" target="_blank" rel="noopener noreferrer">${value}</a>`;
    }

    // Handle dates
    if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
      return `<time datetime="${value}">${value}</time>`;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      if (value.length === 0) return '<span class="text-muted">[]</span>';
      if (value.length > 5) {
        return `<span class="badge bg-secondary">${value.length} items</span>`;
      }
      return value.map(v => `<span class="badge bg-light text-dark me-1">${formatValue(v, key)}</span>`).join('');
    }

    // Handle objects (nested properties)
    if (typeof value === 'object' && value !== null) {
      return '<details class="mt-1"><summary class="text-muted small" style="cursor: pointer;">View nested properties</summary><pre class="mt-1 small">' +
        JSON.stringify(value, null, 2) + '</pre></details>';
    }

    // Handle booleans
    if (typeof value === 'boolean') {
      return value ?
        '<i class="fas fa-check-circle text-success"></i>' :
        '<i class="fas fa-times-circle text-danger"></i>';
    }

    // Handle numbers
    if (typeof value === 'number') {
      // Check if it's a percentage (property name contains 'percent' or value is between 0-100)
      if (key.includes('percent') || key.includes('progress')) {
        return `<div class="progress" style="height: 20px; min-width: 100px;">
          <div class="progress-bar" role="progressbar" style="width: ${value}%" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100">${value}%</div>
        </div>`;
      }
      return value.toLocaleString();
    }

    // Default: return as string
    return String(value);
  }

  // Helper to format property keys (convert snake_case to Title Case)
  function formatKey(key) {
    return key
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  // Separate important properties from the rest
  const importantKeys = ['title', 'status', 'priority', 'category', 'goal', 'cover_image',
                         'start_date', 'target_date', 'percent_done', 'progress_summary'];
  const metricKeys = Object.keys(properties).filter(k => k === 'metrics' || k.includes('savings') || k.includes('next_'));

  const important = {};
  const metrics = {};
  const other = {};

  for (const [key, value] of Object.entries(properties)) {
    if (importantKeys.includes(key)) {
      important[key] = value;
    } else if (metricKeys.includes(key)) {
      metrics[key] = value;
    } else {
      other[key] = value;
    }
  }

  let html = '<div class="properties-card card mb-3 shadow-sm">';
  html += '<div class="card-header bg-light border-bottom">';
  html += '<h6 class="mb-0"><i class="fas fa-info-circle me-2"></i>Properties</h6>';
  html += '</div>';
  html += '<div class="card-body">';

  // Render cover image first if present
  if (important.cover_image) {
    html += '<div class="mb-3">' + formatValue(important.cover_image, 'cover_image') + '</div>';
  }

  // Render important properties
  if (Object.keys(important).length > 0) {
    html += '<div class="row g-2 mb-3">';
    for (const [key, value] of Object.entries(important)) {
      if (key === 'cover_image') continue; // Already rendered
      const colSize = key === 'goal' || key === 'progress_summary' ? 'col-12' : 'col-md-6';
      html += `<div class="${colSize}">`;
      html += `<div class="d-flex flex-column">`;
      html += `<small class="text-muted">${formatKey(key)}</small>`;
      html += `<div>${formatValue(value, key)}</div>`;
      html += `</div></div>`;
    }
    html += '</div>';
  }

  // Render metrics in a collapsible section
  if (Object.keys(metrics).length > 0) {
    html += '<details class="mb-2">';
    html += '<summary class="text-primary fw-bold" style="cursor: pointer; user-select: none;"><i class="fas fa-chart-line me-2"></i>Metrics & Targets</summary>';
    html += '<div class="mt-2 row g-2">';
    for (const [key, value] of Object.entries(metrics)) {
      html += `<div class="col-md-6">`;
      html += `<div class="d-flex flex-column">`;
      html += `<small class="text-muted">${formatKey(key)}</small>`;
      html += `<div>${formatValue(value, key)}</div>`;
      html += `</div></div>`;
    }
    html += '</div></details>';
  }

  // Render other properties in a collapsed section
  if (Object.keys(other).length > 0) {
    html += '<details>';
    html += '<summary class="text-muted small" style="cursor: pointer; user-select: none;"><i class="fas fa-ellipsis-h me-2"></i>Additional Properties</summary>';
    html += '<div class="mt-2 row g-2 small">';
    for (const [key, value] of Object.entries(other)) {
      html += `<div class="col-md-6">`;
      html += `<div class="d-flex flex-column">`;
      html += `<small class="text-muted">${formatKey(key)}</small>`;
      html += `<div>${formatValue(value, key)}</div>`;
      html += `</div></div>`;
    }
    html += '</div></details>';
  }

  html += '</div></div>';

  return html;
}

// Dataview API Implementation
// Provides a subset of Obsidian Dataview functionality for rendering dashboards
class DataviewAPI {
  constructor(vaultPath, currentFilePath, allFiles) {
    this.vaultPath = vaultPath;
    this.currentFilePath = currentFilePath;
    this.allFiles = allFiles; // Pre-loaded files
    this._outputBuffer = []; // Accumulates rendered HTML
  }

  // Get all files in the vault with their frontmatter (static method for initialization)
  static async getAllFiles(vaultPath) {
    const files = [];

    async function walkDir(dir, relativePath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const fullPath = path.join(dir, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          await walkDir(fullPath, relPath);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const { properties } = parseFrontmatter(content);

            files.push({
              path: relPath,
              name: entry.name.replace('.md', ''),
              folder: path.dirname(relPath),
              frontmatter: properties || {},
              file: {
                path: relPath,
                name: entry.name.replace('.md', ''),
                folder: path.dirname(relPath)
              }
            });
          } catch (error) {
            // Silently skip files we can't read (error already logged in parseFrontmatter)
            // This prevents flooding logs when scanning large vaults
          }
        }
      }
    }

    await walkDir(vaultPath);
    return files;
  }

  // Query pages by folder or tag (now synchronous since files are pre-loaded)
  pages(source) {
    const allFiles = this.allFiles;

    // Handle folder queries like "projects" or '"projects"'
    const folderMatch = source.match(/^["']?([^"']+)["']?$/);
    if (folderMatch) {
      const folder = folderMatch[1];
      const filtered = allFiles.filter(file => {
        return file.folder === folder || file.path.startsWith(folder + '/');
      });

      return new DataviewArray(...filtered);
    }

    // Default: return all files
    return new DataviewArray(...allFiles);
  }

  // Parse date string and return a date with duration methods
  date(dateStr) {
    const d = dateStr === 'today' ? new Date() : new Date(dateStr);

    // Add duration methods like Luxon DateTime
    d.minus = function(duration) {
      const result = new Date(this);
      if (duration.days) result.setDate(result.getDate() - duration.days);
      if (duration.weeks) result.setDate(result.getDate() - (duration.weeks * 7));
      if (duration.months) result.setMonth(result.getMonth() - duration.months);
      if (duration.years) result.setFullYear(result.getFullYear() - duration.years);
      return result;
    };

    d.plus = function(duration) {
      const result = new Date(this);
      if (duration.days) result.setDate(result.getDate() + duration.days);
      if (duration.weeks) result.setDate(result.getDate() + (duration.weeks * 7));
      if (duration.months) result.setMonth(result.getMonth() + duration.months);
      if (duration.years) result.setFullYear(result.getFullYear() + duration.years);
      return result;
    };

    return d;
  }

  // Create a file link (Obsidian-style: strip .md extension from URLs)
  fileLink(filePath, embed = false, alias = null) {
    // Extract display text from alias or filename
    const displayText = alias || path.basename(filePath, '.md');

    // Create clean URL path (strip .md extension, Obsidian-style)
    let linkPath = filePath.replace(/\.md$/, '');

    // Ensure it starts with /
    if (!linkPath.startsWith('/')) {
      linkPath = '/' + linkPath;
    }

    return `<a href="${linkPath}">${displayText}</a>`;
  }

  // Render a table
  table(headers, rows) {
    let html = '<table class="dataview-table table table-striped table-hover">\n';
    html += '<thead><tr>';
    for (const header of headers) {
      html += `<th>${header}</th>`;
    }
    html += '</tr></thead>\n<tbody>';

    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) {
        const cellValue = cell === null || cell === undefined ? '-' : cell;
        html += `<td>${cellValue}</td>`;
      }
      html += '</tr>\n';
    }

    html += '</tbody></table>';
    return html;
  }

  // Render a list
  list(items) {
    let html = '<ul class="dataview-list">\n';
    for (const item of items) {
      html += `<li>${item}</li>\n`;
    }
    html += '</ul>';
    return html;
  }

  // Render a paragraph
  paragraph(text) {
    this._outputBuffer.push(`<p>${text}</p>`);
    return `<p>${text}</p>`;
  }

  // Get current page metadata
  current() {
    const relPath = this.currentFilePath.replace(this.vaultPath + '/', '').replace(/^\//, '');
    const page = this.allFiles.find(f => f.path === relPath);
    if (page) {
      return { ...page, ...page.frontmatter, file: page.file };
    }
    // Return basic info if page not found
    return {
      file: {
        path: relPath,
        name: path.basename(relPath, '.md'),
        folder: path.dirname(relPath)
      }
    };
  }

  // Get a single page by path
  page(pagePath) {
    // Normalize the path - remove quotes, add .md if needed
    let normalizedPath = pagePath.replace(/^["']|["']$/g, '');
    if (!normalizedPath.endsWith('.md')) {
      normalizedPath += '.md';
    }

    const page = this.allFiles.find(f =>
      f.path === normalizedPath ||
      f.path === normalizedPath.replace('.md', '') + '.md'
    );

    if (page) {
      return { ...page, ...page.frontmatter, file: page.file };
    }
    return null;
  }

  // Create an HTML element (accumulates in output buffer)
  el(tag, content, options = {}) {
    const { container, attr = {}, cls } = options;

    // Build attributes string
    let attrStr = '';
    if (cls) {
      attrStr += ` class="${cls}"`;
    }
    for (const [key, value] of Object.entries(attr)) {
      // Make internal links absolute (they're relative to vault root in Obsidian)
      if (key === 'href' && (cls === 'internal-link' || (attr.class && attr.class.includes('internal-link')))) {
        const absoluteHref = value.startsWith('/') ? value : '/' + value;
        attrStr += ` ${key}="${absoluteHref}"`;
      } else {
        attrStr += ` ${key}="${value}"`;
      }
    }

    // Create a pseudo-element that tracks its children
    const element = {
      _tag: tag,
      _attrStr: attrStr,
      _content: content,
      _children: [],
      innerHTML: '',
      // Render this element and all its children
      render() {
        let childContent = this._children.map(c => c.render ? c.render() : c).join('');
        let innerContent = this._content + childContent + this.innerHTML;
        return `<${this._tag}${this._attrStr}>${innerContent}</${this._tag}>`;
      }
    };

    // If there's a container, add this element as a child
    if (container && container._children) {
      container._children.push(element);
    } else {
      // Root element - add to the root elements list
      if (!this._rootElements) {
        this._rootElements = [];
      }
      this._rootElements.push(element);
    }

    return element;
  }

  // IO utilities
  get io() {
    const self = this;
    return {
      async load(filePath) {
        const fullPath = path.join(self.vaultPath, filePath);
        try {
          return await fs.readFile(fullPath, 'utf-8');
        } catch (error) {
          console.error('Error loading file:', filePath, error);
          return '';
        }
      }
    };
  }

  // View - load and execute an external script
  async view(scriptPath, input = {}) {
    // Resolve the script path
    let fullScriptPath = path.join(this.vaultPath, scriptPath);
    if (!fullScriptPath.endsWith('.js')) {
      fullScriptPath += '.js';
    }

    try {
      const scriptContent = await fs.readFile(fullScriptPath, 'utf-8');

      // Create a child DataviewAPI for the view with its own output buffer
      const viewDv = new DataviewAPI(this.vaultPath, this.currentFilePath, this.allFiles);

      // Execute the script in a sandbox with dv and input available
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const scriptFn = new AsyncFunction('dv', 'input', scriptContent);
      await scriptFn(viewDv, input);

      // Get the output from the view
      const output = viewDv.getOutput();
      this._outputBuffer.push(output);

      return output;
    } catch (error) {
      console.error('Error executing view:', scriptPath, error);
      const errorHtml = `<div class="alert alert-warning">DataviewJS Error: ${error.message}</div>`;
      this._outputBuffer.push(errorHtml);
      return errorHtml;
    }
  }

  // Get all accumulated output
  getOutput() {
    // Render all root elements created with dv.el()
    const elementsHtml = (this._rootElements || []).map(el => el.render()).join('\n');
    // Combine with any direct output (from dv.paragraph, dv.table, etc.)
    return this._outputBuffer.join('\n') + elementsHtml;
  }
}

// DataviewArray - wraps an array with Dataview query methods
class DataviewArray extends Array {
  where(predicate) {
    const filtered = this.filter(item => {
      // Make frontmatter properties available directly on item
      const enrichedItem = { ...item, ...item.frontmatter };
      return predicate(enrichedItem);
    });
    return new DataviewArray(...filtered);
  }

  sort(keyOrComparator, direction = 'asc') {
    const sorted = [...this].sort((a, b) => {
      const aEnriched = { ...a, ...a.frontmatter };
      const bEnriched = { ...b, ...b.frontmatter };

      let aVal, bVal;

      if (typeof keyOrComparator === 'function') {
        aVal = keyOrComparator(aEnriched);
        bVal = keyOrComparator(bEnriched);
      } else {
        aVal = aEnriched[keyOrComparator];
        bVal = bEnriched[keyOrComparator];
      }

      // Handle null/undefined
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      // Handle dates
      if (aVal instanceof Date && bVal instanceof Date) {
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
      }

      // Handle strings
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        const result = aVal.localeCompare(bVal);
        return direction === 'asc' ? result : -result;
      }

      // Handle numbers
      const result = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return direction === 'asc' ? result : -result;
    });

    return new DataviewArray(...sorted);
  }

  map(fn) {
    const mapped = Array.from(this).map((item, index) => {
      const enrichedItem = { ...item, ...item.frontmatter };
      return fn(enrichedItem, index, this);
    });
    // Return DataviewArray to maintain chainability
    return new DataviewArray(...mapped);
  }

  // Convert to regular array
  array() {
    return Array.from(this).map(item => {
      // If item has frontmatter, enrich it; otherwise return as-is
      return item.frontmatter ? { ...item, ...item.frontmatter } : item;
    });
  }

  // Filter with predicate (returns DataviewArray)
  filter(predicate) {
    const filtered = Array.from(this).filter((item, index) => {
      // If item has frontmatter, enrich it; otherwise use as-is (for already-mapped items)
      const enrichedItem = item.frontmatter ? { ...item, ...item.frontmatter } : item;
      return predicate(enrichedItem, index, this);
    });
    return new DataviewArray(...filtered);
  }

  get length() {
    return Array.from(this).length;
  }
}

// Execute DataviewJS code block
async function executeDataviewJS(code, vaultPath, currentFilePath) {
  try {
    // Pre-load all files so dv.pages() can be synchronous
    const allFiles = await DataviewAPI.getAllFiles(vaultPath);
    const dv = new DataviewAPI(vaultPath, currentFilePath, allFiles);

    // Create a safe sandbox context
    const context = {
      dv,
      console: {
        log: (...args) => debug('[DataviewJS]', ...args),
        error: (...args) => debug('[DataviewJS Error]', ...args)
      }
    };

    // Collect rendered output
    let output = '';

    // Override dv.table and dv.list to capture output
    const originalTable = dv.table.bind(dv);
    const originalList = dv.list.bind(dv);
    const originalParagraph = dv.paragraph.bind(dv);

    dv.table = (...args) => {
      output += originalTable(...args);
    };

    dv.list = (...args) => {
      output += originalList(...args);
    };

    dv.paragraph = (...args) => {
      output += originalParagraph(...args);
    };

    // Create async function and execute
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction('dv', 'console', code);
    await fn(dv, context.console);

    // Return both manual capture and buffer output
    const bufferOutput = dv.getOutput();
    return output + bufferOutput;
  } catch (error) {
    debug('DataviewJS execution error:', error);
    return `<div class="alert alert-danger"><strong>DataviewJS Error:</strong> ${error.message}</div>`;
  }
}

// Process dataviewjs code blocks in markdown content
async function processDataviewJSBlocks(content, vaultPath, currentFilePath) {
  const codeBlockRegex = /```dataviewjs\s*([\s\S]*?)```/g;
  let processedContent = content;
  const matches = [];
  let match;

  // Collect all matches first to avoid regex index issues
  while ((match = codeBlockRegex.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      code: match[1],
      index: match.index
    });
  }

  // Process matches in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, code: rawCode } = matches[i];

    // Remove blockquote markers (>) from code if it's inside a collapsible section
    const code = rawCode.split('\n')
      .map(line => line.replace(/^>\s*/, ''))
      .join('\n');

    try {
      debug(`Executing dataviewjs block`);
      const html = await executeDataviewJS(code, vaultPath, currentFilePath);

      // Replace the code block with the rendered HTML
      processedContent = processedContent.replace(fullMatch, html);
    } catch (error) {
      debug('Error executing dataviewjs block:', error);
      const errorHtml = `<div class="alert alert-danger" role="alert">
        <strong>Dataview Error:</strong> ${error.message}
      </div>`;
      processedContent = processedContent.replace(fullMatch, errorHtml);
    }
  }

  return processedContent;
}

// Process inline dataview expressions ($= syntax and =this.property syntax)
async function processInlineDataview(content, properties, vaultPath, currentFilePath) {
  // First, handle simple =this.property syntax (Obsidian Dataview style)
  // Match =this.property where property is alphanumeric/underscore
  // Must not be inside backticks or code blocks
  const thisPropertyRegex = /=this\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

  let thisMatch;
  const thisMatches = [];
  while ((thisMatch = thisPropertyRegex.exec(content)) !== null) {
    thisMatches.push({
      fullMatch: thisMatch[0],
      propName: thisMatch[1],
      index: thisMatch.index
    });
  }

  // Process =this.property matches in reverse to maintain indices
  for (let i = thisMatches.length - 1; i >= 0; i--) {
    const { fullMatch, propName, index } = thisMatches[i];
    const value = properties?.[propName];

    if (value !== undefined) {
      // Format the value appropriately
      let displayValue;
      if (Array.isArray(value)) {
        displayValue = value.join(', ');
      } else if (value instanceof Date) {
        displayValue = value.toISOString().split('T')[0];
      } else {
        displayValue = String(value);
      }

      content = content.substring(0, index) +
                displayValue +
                content.substring(index + fullMatch.length);
    }
  }

  // Then handle $= expressions inside backticks: `$= expression`
  const inlineRegex = /`\$=\s*([^`]+?)`/g;

  const matches = [];
  let match;
  while ((match = inlineRegex.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      expression: match[1].trim(),
      index: match.index
    });
  }

  // Process in reverse to maintain indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, expression } = matches[i];

    try {
      let result;

      // Handle this.property syntax
      if (expression.startsWith('this.')) {
        const propName = expression.substring(5);
        result = properties?.[propName];
      } else if (expression.includes('dv.pages')) {
        // Execute the expression using DataviewAPI (with pre-loaded files)
        const allFiles = await DataviewAPI.getAllFiles(vaultPath);
        const dv = new DataviewAPI(vaultPath, currentFilePath, allFiles);
        // Inline expressions are synchronous, so we can just evaluate directly
        const fn = new Function('dv', `return ${expression}`);
        result = fn(dv);
      } else {
        result = fullMatch; // Keep original if we can't process
      }

      if (result !== undefined && result !== fullMatch) {
        content = content.substring(0, matches[i].index) +
                  result +
                  content.substring(matches[i].index + fullMatch.length);
      }
    } catch (error) {
      debug('Error processing inline dataview:', error);
      // Keep the original expression on error
    }
  }

  return content;
}

// Simple cache for task query results (expires after 30 seconds)
const taskQueryCache = new Map();
const TASK_QUERY_CACHE_TTL = 30000; // 30 seconds

// Execute Obsidian Tasks query and return matching tasks
async function executeTasksQuery(query) {
  const db = getReadOnlyDatabase();

  // Remove blockquote markers (>) from query lines
  const lines = query.trim().split('\n')
    .map(l => l.replace(/^>\s*/, '').trim())
    .filter(Boolean);

  // Parse query components
  let filters = [];
  let sortBy = null;
  let sortReverse = false;
  let groupBy = null;

  for (const line of lines) {
    if (line.startsWith('sort by')) {
      const sortMatch = line.match(/sort by (\w+)( reverse)?/);
      if (sortMatch) {
        sortBy = sortMatch[1];
        sortReverse = !!sortMatch[2];
      }
    } else if (line.startsWith('group by')) {
      groupBy = line.replace('group by ', '').trim();
    } else {
      filters.push(line);
    }
  }

  // Check cache first
  const cacheKey = JSON.stringify({ filters, sortBy, sortReverse, groupBy });
  const cached = taskQueryCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < TASK_QUERY_CACHE_TTL)) {
    debug(`[TASK QUERY CACHE HIT] ${filters.join(', ')}`);
    return cached.result;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Build SQL query for the tasks table
  let sqlWhere = [];

  // Analyze filters to build SQL WHERE clauses
  for (const filter of filters) {
    if (filter === 'done') {
      sqlWhere.push(`status = 'completed'`);
    } else if (filter === 'not done') {
      sqlWhere.push(`status = 'open'`);
    } else if (filter === 'done today') {
      sqlWhere.push(`status = 'completed'`);
      sqlWhere.push(`DATE(completed_at) = '${todayStr}'`);
    } else if (filter.includes('OR') && filter.includes('before tomorrow')) {
      // Handle "(scheduled before tomorrow) OR (due before tomorrow)"
      sqlWhere.push(`(due_date <= '${todayStr}' OR json_extract(metadata, '$.scheduled_date') <= '${todayStr}')`);
    }
  }

  // Get tasks from database
  let taskRows = [];
  try {
    const whereClause = sqlWhere.length > 0 ? `WHERE ${sqlWhere.join(' AND ')}` : '';
    const sql = `
      SELECT id, title, status, priority, due_date, completed_at, metadata, source
      FROM tasks
      ${whereClause}
    `;
    taskRows = db.prepare(sql).all();
    debug(`SQL filtered: ${taskRows.length} tasks from tasks table`);
  } catch (error) {
    debug('Error querying tasks table:', error.message);
    taskRows = [];
  }

  // Priority mapping (text to numeric for sorting)
  const priorityMap = { highest: 4, high: 3, medium: 2, low: 1, lowest: 0 };

  // Convert to standard task format
  const tasks = taskRows.map(row => {
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};
    const scheduledDate = metadata.scheduled_date ? new Date(metadata.scheduled_date + 'T00:00:00') : null;
    const dueDate = row.due_date ? new Date(row.due_date + 'T00:00:00') : null;
    const doneDate = row.completed_at ? new Date(row.completed_at) : null;

    return {
      id: row.id,
      text: row.title,
      originalText: row.title,
      isDone: row.status === 'completed',
      isCancelled: row.status === 'cancelled',
      scheduledDate,
      dueDate,
      doneDate,
      priority: priorityMap[row.priority] || 0,
      priorityText: row.priority,
      happens: scheduledDate || dueDate,
      source: row.source
    };
  });

  // Apply any remaining JavaScript filters
  let filtered = tasks;
  for (const filter of filters) {
    if (filter === 'no scheduled date') {
      filtered = filtered.filter(t => !t.scheduledDate);
    } else if (filter === 'no due date') {
      filtered = filtered.filter(t => !t.dueDate);
    } else if (filter.startsWith('path includes ')) {
      const pathPattern = filter.replace('path includes ', '').trim();
      filtered = filtered.filter(t => t.source && t.source.includes(pathPattern));
    } else if (filter.startsWith('path does not include ')) {
      const pathPattern = filter.replace('path does not include ', '').trim();
      filtered = filtered.filter(t => !t.source || !t.source.includes(pathPattern));
    }
  }

  // Sort
  if (sortBy === 'priority') {
    filtered.sort((a, b) => sortReverse ? a.priority - b.priority : b.priority - a.priority);
  } else if (sortBy === 'done') {
    filtered.sort((a, b) => {
      const aTime = a.doneDate ? a.doneDate.getTime() : 0;
      const bTime = b.doneDate ? b.doneDate.getTime() : 0;
      return sortReverse ? bTime - aTime : aTime - bTime;
    });
  }

  // Group
  if (groupBy === 'happens') {
    const grouped = new Map();
    for (const task of filtered) {
      const date = task.happens;
      const key = date ? date.toISOString().split('T')[0] : 'No date';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(task);
    }

    // Sort groups by date
    const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
      if (a[0] === 'No date') return 1;
      if (b[0] === 'No date') return -1;
      return a[0].localeCompare(b[0]);
    });

    const result = { grouped: sortedGroups };
    taskQueryCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  const result = { tasks: filtered };
  taskQueryCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

// Process tasks code blocks in markdown content
async function processTasksCodeBlocks(content, skipBlockquotes = false) {
  // Match both with and without newlines, and handle different line endings
  const codeBlockRegex = /```tasks\s*([\s\S]*?)```/g;
  let processedContent = content;
  const matches = [];
  let match;

  // Collect all matches first to avoid regex index issues
  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Check if this match is inside a blockquote by looking at the line it's on
    const beforeMatch = content.substring(0, match.index);
    const afterLastNewline = beforeMatch.lastIndexOf('\n');
    const lineStart = beforeMatch.substring(afterLastNewline + 1);
    const isInBlockquote = lineStart.startsWith('>');

    // Skip blockquote tasks if requested
    if (skipBlockquotes && isInBlockquote) {
      debug(`Skipping tasks block in blockquote`);
      continue;
    }

    matches.push({
      fullMatch: match[0],
      query: match[1]
    });
  }

  debug(`Found ${matches.length} tasks code blocks to process`);

  // Process each match
  for (const { fullMatch, query } of matches) {
    debug(`Processing query:`, query);
    const result = await executeTasksQuery(query);

    let replacement = '<div class="tasks-query-result">\n';

    if (result.grouped) {
      // Render grouped results
      for (const [groupKey, tasks] of result.grouped) {
        if (tasks.length === 0) continue;

        // Format header based on group type
        let dateHeader = groupKey;
        if (result.groupType !== 'custom' && groupKey !== 'No date') {
          // Only parse as date if we're grouping by date
          const d = new Date(groupKey + 'T00:00:00');
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);

          if (!isNaN(d.getTime())) {
            if (d.toDateString() === today.toDateString()) {
              dateHeader = 'Today';
            } else if (d.toDateString() === tomorrow.toDateString()) {
              dateHeader = 'Tomorrow';
            } else {
              dateHeader = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            }
          }
        }

        replacement += `<h4>${dateHeader}</h4>\n<ul>\n`;
        for (const task of tasks) {
          const checkbox = task.isDone ? 'checked' : '';
          const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
          const priorityIcon = task.priority === 3 ? '🔺 ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '⏫ ' : '';
          // Strip blockquote markers from task text (tasks inside callouts have "> - [ ] text")
          let displayText = replaceTagsWithEmojis(task.text.replace(/^>\s*-\s*\[([ xX-])\]\s*/, ''));
          // Add completion date if task is done
          if (task.isDone && task.doneDate) {
            const dateStr = task.doneDate.toISOString().split('T')[0];
            displayText += ` ✅ ${dateStr}`;
          }
          // Add cancelled indicator if task is cancelled
          if (task.isCancelled) {
            displayText += ` <span class="text-muted">(cancelled)</span>`;
          }

          // Use task.id directly for the link (tasks come from tasks table)
          const taskLink = task.id ? `/task/${task.id}` : '';

          replacement += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
          replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
          if (taskLink) {
            replacement += `<a href="${taskLink}" style="text-decoration: none; color: inherit;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${priorityIcon}${displayText}</a>`;
          } else {
            replacement += `${priorityIcon}${displayText}`;
          }
          replacement += `</li>\n`;
        }
        replacement += '</ul>\n';
      }
    } else {
      // Render ungrouped results
      if (result.tasks.length > 0) {
        replacement += '<ul>\n';
        for (const task of result.tasks) {
          const checkbox = task.isDone ? 'checked' : '';
          const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
          const priorityIcon = task.priority === 4 ? '🔺 ' : task.priority === 3 ? '⏫ ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '🔽 ' : '';
          let displayText = replaceTagsWithEmojis(task.text);
          // Add completion date if task is done
          if (task.isDone && task.doneDate) {
            const dateStr = task.doneDate.toISOString().split('T')[0];
            displayText += ` ✅ ${dateStr}`;
          }
          // Add cancelled indicator if task is cancelled
          if (task.isCancelled) {
            displayText += ` <span class="text-muted">(cancelled)</span>`;
          }

          // Use task.id directly for the link
          const taskLink = task.id ? `/task/${task.id}` : '';

          replacement += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
          replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
          if (taskLink) {
            replacement += `<a href="${taskLink}" style="text-decoration: none; color: inherit;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${priorityIcon}${displayText}</a>`;
          } else {
            replacement += `${priorityIcon}${displayText}`;
          }
          replacement += `</li>\n`;
        }
        replacement += '</ul>\n';
      } else {
        replacement += '<p class="text-muted">No matching tasks</p>\n';
      }
    }

    replacement += '</div>';

    processedContent = processedContent.replace(fullMatch, replacement);
  }

  return processedContent;
}


// Uncached Markdown rendering (original implementation)
async function renderMarkdownUncached(filePath, urlPath) {
  debug('renderMarkdown called for:', urlPath);
  let content = await fs.readFile(filePath, 'utf-8');

  // Get current timer info
  const currentTimer = await getCurrentTimer();

  // Parse YAML frontmatter
  const { properties, contentWithoutFrontmatter } = parseFrontmatter(content);
  content = contentWithoutFrontmatter;

  // IMPORTANT: Save the original content BEFORE any modifications
  // This is needed for accurate line tracking when mapping checkboxes
  const originalContent = content;
  const relativeFilePath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;

  // Insert metadata markers that won't break marked.js checkbox detection
  // We'll use {data-file="..." data-line="..."} which marked.js will pass through
  // Updated regex to also match tasks inside blockquotes (lines starting with >) and cancelled tasks
  const taskRegex = /^((?:\s*>)*\s*)- \[[ x-]\] (.+)$/i;
  const originalLines = originalContent.split('\n');

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i];
    const match = line.match(taskRegex);
    if (match) {
      const lineNumber = i + 1; // 1-based line numbers
      const prefix = match[1]; // This now includes any > prefixes
      const isChecked = line.includes('[x]') || line.includes('[X]');
      const isCancelled = line.includes('[-]');
      const taskText = match[2];

      // Add metadata as a suffix that marked.js will preserve
      // Convert cancelled tasks to unchecked for markdown parser, but preserve cancelled state in metadata
      const checkboxState = isChecked ? 'x' : ' '; // Always use valid markdown checkbox states
      const metadata = isCancelled ? `{data-file="${relativeFilePath}" data-line="${lineNumber}" data-cancelled="true"}` : `{data-file="${relativeFilePath}" data-line="${lineNumber}"}`;
      originalLines[i] = `${prefix}- [${checkboxState}] ${taskText} ${metadata}`;
    }
  }
  content = originalLines.join('\n');

  // NOTE: Tasks code blocks are processed AFTER markdown rendering to avoid
  // breaking HTML when tasks blocks are inside list items. See post-rendering
  // processing below for <pre><code class="language-tasks"> blocks.

  // Process dataviewjs code blocks before rendering
  const vaultPath = path.join(process.cwd(), 'vault');
  content = await processDataviewJSBlocks(content, vaultPath, filePath);

  // Process inline dataview expressions
  content = await processInlineDataview(content, properties, vaultPath, filePath);

  // Don't process collapsible sections here - we'll do it after markdown rendering

  const lines = content.split('\n');

  // Extract title from first H1 if it exists
  let pageTitle = path.basename(urlPath, '.md');
  let contentToRender = content;
  const titleMatch = content.match(/^# (.+)$/m);
  if (titleMatch) {
    pageTitle = titleMatch[1];
    // Remove the title from content so it's not duplicated
    contentToRender = content.replace(/^# .+\n?/m, '');
  }

  // Replace tags with emojis in the markdown content
  contentToRender = replaceTagsWithEmojis(contentToRender);

  // Find all checkbox lines in the ORIGINAL content (before modifications)
  // We need to exclude checkboxes inside ```tasks blocks since those are rendered separately
  const checkboxLines = [];
  let inTasksBlock = false;

  originalLines.forEach((line, index) => {
    // Check if we're entering or leaving a ```tasks block
    if (line.match(/^```tasks/)) {
      inTasksBlock = true;
    } else if (inTasksBlock && line === '```') {
      inTasksBlock = false;
    } else if (!inTasksBlock && line.match(/^(\s*)-\s*\[([x\s-])\]\s*/i)) {
      // Only include checkboxes that are NOT inside ```tasks blocks
      // DEPRECATED: Extract task ID if present (old task-id system, keeping for compatibility)
      const taskIdMatch = line.match(/<![-—]+ task-id: ([a-f0-9]{32}) [-—]+>/);
      checkboxLines.push({
        lineNumber: index,
        isChecked: line.match(/^(\s*)-\s*\[[xX]\]\s*/i) !== null,
        isCancelled: line.match(/^(\s*)-\s*\[-\]\s*/i) !== null,
        taskId: taskIdMatch ? taskIdMatch[1] : null
      });
    }
  });
  
  // Use custom renderer for external links
  const renderer = createExternalLinkRenderer();

  // Override the checkbox renderer to make checkboxes enabled (not disabled by default)
  renderer.checkbox = function(checkedObj) {
    // The parameter is an object with a 'checked' property, not a boolean
    const isChecked = checkedObj && checkedObj.checked;
    // Return enabled checkboxes without the disabled attribute
    return `<input type="checkbox" class="task-checkbox"${isChecked ? ' checked' : ''}>`;
  };

  // Render the markdown with custom renderer (heading IDs added by marked-gfm-heading-id)
  let htmlContent = marked.parse(contentToRender, { renderer });

  // Generate TOC from the parsed headings (must be called after marked.parse)
  const toc = generateTableOfContents();

  // Convert emojis to Font Awesome icons
  htmlContent = convertEmojisToIcons(htmlContent);
  
  // Enhance tables with MDBootstrap styling
  htmlContent = htmlContent.replace(/<table>/g, '<table class="table table-hover table-striped">');
  
  // Process Obsidian callouts in rendered blockquotes
  // First handle callouts that contain task queries (which appear as code blocks in the HTML)
  htmlContent = await (async () => {
    // Match blockquotes with Obsidian callout syntax that contain code blocks
    // Marked.js adds class="language-tasks" to the code tag
    const calloutWithCodeRegex = /<blockquote>\n?<p>\[!(note|info|todo|abstract|summary|tldr|success|check|done|tip|hint|important|question|help|faq|warning|caution|attention|failure|fail|missing|danger|error|bug|example|quote|cite)\]([-+]?)\s*(.*?)<\/p>\n?<pre(?:[^>]*)><code(?:\s+class="language-tasks"[^>]*)?>([\s\S]*?)<\/code><\/pre>([\s\S]*?)<\/blockquote>/gi;

    let result = htmlContent;
    const matches = [];
    let match;

    // Collect all matches
    while ((match = calloutWithCodeRegex.exec(htmlContent)) !== null) {
      matches.push({
        fullMatch: match[0],
        type: match[1],
        modifier: match[2],
        title: match[3],
        query: match[4],
        additionalContent: match[5]
      });
    }

    // Process each match
    for (const { fullMatch, type, modifier, title, query, additionalContent } of matches) {
      debug(`Processing Obsidian callout with tasks query`);

      // Execute the tasks query
      const queryResult = await executeTasksQuery(query);

      // Build the tasks HTML
      let tasksHtml = '';
      if (queryResult.grouped) {
        for (const [groupKey, tasks] of queryResult.grouped) {
          if (tasks.length === 0) continue;

          // Format header
          let dateHeader = groupKey;
          if (queryResult.groupType !== 'custom' && groupKey !== 'No date') {
            const d = new Date(groupKey + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            if (!isNaN(d.getTime())) {
              if (d.toDateString() === today.toDateString()) {
                dateHeader = 'Today';
              } else if (d.toDateString() === tomorrow.toDateString()) {
                dateHeader = 'Tomorrow';
              } else {
                dateHeader = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
              }
            }
          }

          tasksHtml += `<h4>${dateHeader}</h4>\n<ul>\n`;
          for (const task of tasks) {
            const checkbox = task.isDone ? 'checked' : '';
            const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
            const priorityIcon = task.priority === 3 ? '🔺 ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '⏫ ' : '';
            // Strip blockquote markers from task text (tasks inside callouts have "> - [ ] text")
            let displayText = replaceTagsWithEmojis(task.text.replace(/^>\s*-\s*\[([ xX-])\]\s*/, ''));
            if (task.isDone && task.doneDate) {
              const dateStr = task.doneDate.toISOString().split('T')[0];
              displayText += ` ✅ ${dateStr}`;
            }
            // Add cancelled indicator if task is cancelled
            if (task.isCancelled) {
              displayText += ` <span class="text-muted">(cancelled)</span>`;
            }
            const taskLink = task.id ? `/task/${task.id}` : '';
            tasksHtml += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
            tasksHtml += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
            if (taskLink) {
              tasksHtml += `<a href="${taskLink}" style="text-decoration: none; color: inherit;">${priorityIcon}${displayText}</a>`;
            } else {
              tasksHtml += `${priorityIcon}${displayText}`;
            }
            tasksHtml += `</li>\n`;
          }
          tasksHtml += '</ul>\n';
        }
      } else {
        if (queryResult.tasks.length > 0) {
          tasksHtml += '<ul>\n';
          for (const task of queryResult.tasks) {
            const checkbox = task.isDone ? 'checked' : '';
            const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
            const priorityIcon = task.priority === 4 ? '🔺 ' : task.priority === 3 ? '⏫ ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '🔽 ' : '';
            let displayText = replaceTagsWithEmojis(task.text);
            if (task.isDone && task.doneDate) {
              const dateStr = task.doneDate.toISOString().split('T')[0];
              displayText += ` ✅ ${dateStr}`;
            }
            // Add cancelled indicator if task is cancelled
            if (task.isCancelled) {
              displayText += ` <span class="text-muted">(cancelled)</span>`;
            }
            const taskLink = task.id ? `/task/${task.id}` : '';
            tasksHtml += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
            tasksHtml += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
            if (taskLink) {
              tasksHtml += `<a href="${taskLink}" style="text-decoration: none; color: inherit;">${priorityIcon}${displayText}</a>`;
            } else {
              tasksHtml += `${priorityIcon}${displayText}`;
            }
            tasksHtml += `</li>\n`;
          }
          tasksHtml += '</ul>\n';
        } else {
          tasksHtml += '<p class="text-muted">No matching tasks</p>\n';
        }
      }

      // Build the callout HTML
      const calloutType = type.toLowerCase();
      const isCollapsed = modifier === '-';
      const openAttr = isCollapsed ? '' : ' open';
      const calloutTitle = title.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

      const replacement = `<details${openAttr} class="task-section callout-${calloutType}">
<summary>${calloutTitle}</summary>
<div class="section-content">
<div class="tasks-query-result">
${tasksHtml}
</div>
${additionalContent.trim()}
</div>
</details>`;

      result = result.replace(fullMatch, replacement);
    }

    return result;
  })();

  // Then handle regular Obsidian callouts without task queries
  htmlContent = htmlContent.replace(/<blockquote>\n?<p>\[!(note|info|todo|abstract|summary|tldr|success|check|done|tip|hint|important|question|help|faq|warning|caution|attention|failure|fail|missing|danger|error|bug|example|quote|cite)\]([-+]?)\s*(.*?)<\/p>([\s\S]*?)<\/blockquote>/gi,
    (match, type, modifier, title, content) => {
      const calloutType = type.toLowerCase();
      const isCollapsed = modifier === '-';
      const openAttr = isCollapsed ? '' : ' open';
      const calloutTitle = title.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1);

      // Clean up the content - remove extra whitespace but keep the HTML structure
      const cleanContent = content.trim();

      return `<details${openAttr} class="task-section callout-${calloutType}">
<summary>${calloutTitle}</summary>
<div class="section-content">
${cleanContent}
</div>
</details>`;
    });

  // Process tasks code blocks after markdown rendering
  // Marked.js converts ```tasks to <pre><code class="language-tasks">
  htmlContent = await (async () => {
    const tasksCodeBlockRegex = /<pre[^>]*><code[^>]*class="language-tasks"[^>]*>([\s\S]*?)<\/code><\/pre>/gi;
    let result = htmlContent;
    const matches = [];
    let match;

    while ((match = tasksCodeBlockRegex.exec(htmlContent)) !== null) {
      matches.push({
        fullMatch: match[0],
        query: match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
      });
    }

    for (const { fullMatch, query } of matches) {
      const queryResult = await executeTasksQuery(query);

      let replacement = '<div class="tasks-query-result">\n';

      if (queryResult.grouped) {
        for (const [groupKey, tasks] of queryResult.grouped) {
          if (tasks.length === 0) continue;

          let dateHeader = groupKey;
          if (queryResult.groupType !== 'custom' && groupKey !== 'No date') {
            const d = new Date(groupKey + 'T00:00:00');
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            if (!isNaN(d.getTime())) {
              if (d.toDateString() === today.toDateString()) {
                dateHeader = 'Today';
              } else if (d.toDateString() === tomorrow.toDateString()) {
                dateHeader = 'Tomorrow';
              } else {
                dateHeader = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
              }
            }
          }

          replacement += `<h4>${dateHeader}</h4>\n<ul>\n`;
          for (const task of tasks) {
            const checkbox = task.isDone ? 'checked' : '';
            const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
            const priorityIcon = task.priority === 3 ? '🔺 ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '⏫ ' : '';
            let displayText = replaceTagsWithEmojis(task.text.replace(/^>\s*-\s*\[([ xX-])\]\s*/, ''));
            if (task.isDone && task.doneDate) {
              const dateStr = task.doneDate.toISOString().split('T')[0];
              displayText += ` ✅ ${dateStr}`;
            }
            if (task.isCancelled) {
              displayText += ` <span class="text-muted">(cancelled)</span>`;
            }

            const taskLink = task.id ? `/task/${task.id}` : '';
            replacement += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
            replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
            if (taskLink) {
              replacement += `<a href="${taskLink}" style="text-decoration: none; color: inherit;">${priorityIcon}${displayText}</a>`;
            } else {
              replacement += `${priorityIcon}${displayText}`;
            }
            replacement += `</li>\n`;
          }
          replacement += '</ul>\n';
        }
      } else {
        if (queryResult.tasks.length > 0) {
          replacement += '<ul>\n';
          for (const task of queryResult.tasks) {
            const checkbox = task.isDone ? 'checked' : '';
            const taskClass = task.isCancelled ? 'task-cancelled' : (task.isDone ? 'task-done' : '');
            const priorityIcon = task.priority === 4 ? '🔺 ' : task.priority === 3 ? '⏫ ' : task.priority === 2 ? '🔼 ' : task.priority === 1 ? '🔽 ' : '';
            let displayText = replaceTagsWithEmojis(task.text);
            if (task.isDone && task.doneDate) {
              const dateStr = task.doneDate.toISOString().split('T')[0];
              displayText += ` ✅ ${dateStr}`;
            }
            if (task.isCancelled) {
              displayText += ` <span class="text-muted">(cancelled)</span>`;
            }

            const taskLink = task.id ? `/task/${task.id}` : '';
            replacement += `<li data-task-id="${task.id || ''}" class="${taskClass}">`;
            replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-task-id="${task.id || ''}"> `;
            if (taskLink) {
              replacement += `<a href="${taskLink}" style="text-decoration: none; color: inherit;">${priorityIcon}${displayText}</a>`;
            } else {
              replacement += `${priorityIcon}${displayText}`;
            }
            replacement += `</li>\n`;
          }
          replacement += '</ul>\n';
        } else {
          replacement += '<p class="text-muted">No matching tasks</p>\n';
        }
      }

      replacement += '</div>';
      result = result.replace(fullMatch, replacement);
    }

    return result;
  })();

  // Enhance remaining blockquotes with MDBootstrap styling
  htmlContent = htmlContent.replace(/<blockquote>/g, '<blockquote class="blockquote border-start border-4 border-primary ps-3 my-3">');

  // Code block styling is now handled by highlight.js CSS (github-dark theme)

  // Add alerts for certain keywords
  htmlContent = htmlContent.replace(/<p><strong>(NOTE|IMPORTANT|WARNING|TIP):<\/strong>([^<]*)<\/p>/g, function(match, type, content) {
    const alertClass = {
      'NOTE': 'alert-info',
      'IMPORTANT': 'alert-warning', 
      'WARNING': 'alert-danger',
      'TIP': 'alert-success'
    }[type] || 'alert-info';
    const icon = {
      'NOTE': 'info-circle',
      'IMPORTANT': 'exclamation-triangle',
      'WARNING': 'exclamation-circle',
      'TIP': 'lightbulb'
    }[type] || 'info-circle';
    return `<div class="alert ${alertClass} d-flex align-items-center" role="alert">
      <i class="fas fa-${icon} me-2"></i>
      <div><strong>${type}:</strong>${content}</div>
    </div>`;
  });
  
  // Replace details/summary elements with simple collapsible sections
  let collapseId = 0;
  htmlContent = htmlContent.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (match, content) => {
    collapseId++;
    const id = `details-${Date.now()}-${collapseId}`;
    
    // Extract summary and content
    const summaryMatch = content.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    let summaryText = summaryMatch ? summaryMatch[1].trim() : 'Click to expand';
    const detailsContent = content.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '').trim();
    
    // Convert emojis in the summary text
    summaryText = convertEmojisToIcons(summaryText);
    
    // Check if it should be open by default
    const isOpen = match.includes('open');
    
    return `
      <div class="mb-3">
        <div class="d-flex align-items-center p-2 bg-light rounded" 
             style="cursor: pointer; user-select: none;"
             onclick="const content = this.nextElementSibling; const icon = this.querySelector('.fa-chevron-right, .fa-chevron-down'); 
                      if(content.style.display === 'none') {
                        content.style.display = 'block'; 
                        icon.classList.remove('fa-chevron-right'); 
                        icon.classList.add('fa-chevron-down');
                      } else {
                        content.style.display = 'none';
                        icon.classList.remove('fa-chevron-down'); 
                        icon.classList.add('fa-chevron-right');
                      }">
          <i class="fas fa-chevron-${isOpen ? 'down' : 'right'} me-2 text-secondary"></i>
          <strong>${summaryText}</strong>
        </div>
        <div style="display: ${isOpen ? 'block' : 'none'}; padding: 1rem; border-left: 3px solid #dee2e6; margin-left: 0.5rem;">
          ${detailsContent}
        </div>
      </div>
    `;
  });
  
  // Process metadata markers and add them to checkboxes
  // The markers look like {data-file="..." data-line="..."} and were added before marked.js

  // Find checkboxes followed by metadata markers and add the metadata as actual attributes
  // Handle both regular quotes and HTML entities (&quot;) and optional data-cancelled attribute
  htmlContent = htmlContent.replace(
    /<input([^>]*type="checkbox"[^>]*)>(.*?)\{data-file=(&quot;|")([^"&]+)(&quot;|")\s+data-line=(&quot;|")(\d+)(&quot;|")(?:\s+data-cancelled=(&quot;|")(true)(&quot;|"))?\}/gi,
    (match, checkboxAttrs, textBetween, q1, file, q2, q3, line, q4, q5, cancelled, q6) => {
      // Check if checkbox already has data attributes (from ```tasks block)
      if (checkboxAttrs.includes('data-file=') && checkboxAttrs.includes('data-line=')) {
        // Remove the metadata marker but keep existing attributes
        return `<input${checkboxAttrs}>${textBetween}`;
      }

      // Add data attributes to the checkbox
      const isChecked = checkboxAttrs.includes('checked');
      const isCancelled = cancelled === 'true';
      const taskClass = isCancelled ? ' class="task-checkbox task-cancelled"' : ' class="task-checkbox"';
      return `<input type="checkbox"${taskClass} data-file="${file}" data-line="${line}"${isChecked ? ' checked' : ''}>${textBetween}`;
    }
  );

  // Also add data attributes to the parent <li> for easier targeting
  htmlContent = htmlContent.replace(
    /<li>([\s\S]*?)<input([^>]*data-file="([^"]+)"[^>]*data-line="(\d+)"[^>]*)>/gi,
    (match, before, checkboxAttrs, file, line) => {
      // Check if this is a cancelled task by looking at the checkbox class
      const isCancelled = checkboxAttrs.includes('task-cancelled');
      const liClass = isCancelled ? ` class="task-cancelled"` : '';
      return `<li data-file="${file}" data-line="${line}"${liClass}>${before}<input${checkboxAttrs}>`;
    }
  );

  // Clean up any remaining metadata markers that weren't processed (handle both " and &quot;)
  htmlContent = htmlContent.replace(/\{data-file=(&quot;|")[^"&]+(&quot;|")\s+data-line=(&quot;|")\d+(&quot;|")(?:\s+data-cancelled=(&quot;|")true(&quot;|"))?\}/g, '');

  // Enable any remaining checkboxes (from ```tasks blocks that already have data attributes)
  htmlContent = htmlContent.replace(
    /<input[^>]*type="checkbox"[^>]*>/gi,
    (match) => {
      // Just enable all checkboxes
      return match.replace(/\s*disabled="?"?/gi, '');
    }
  );
  
  // Make tasks with IDs clickable - wrap the task text in a link
  htmlContent = htmlContent.replace(
    /<li>(.*?)(<input[^>]*data-task-id="([a-f0-9]{32})"[^>]*>)(.*?)<!-- task-id: ([a-f0-9]{32}) --><\/li>/gi,
    (match, before, checkbox, taskId1, taskContent, taskId2) => {
      // Extract the task text (remove status icons if present)
      let cleanTaskContent = taskContent.trim();
      
      // Check if the task content already contains anchor tags (from marked parsing)
      // If it does, we need to handle it differently to avoid nested links
      if (cleanTaskContent.includes('<a href=')) {
        // Extract the main task text and any URLs
        // First, temporarily replace existing anchor tags with placeholders
        const anchorMatches = [];
        let tempContent = cleanTaskContent.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (anchorMatch, href, linkText) => {
          anchorMatches.push({ href, linkText, anchorMatch });
          return `__ANCHOR_${anchorMatches.length - 1}__`;
        });
        
        // Now wrap the non-link text in the task link
        let wrappedContent = `<a href="/task/${taskId1}" style="text-decoration: none; color: inherit;" 
                  onmouseover="this.style.textDecoration='underline'" 
                  onmouseout="this.style.textDecoration='none'">${tempContent}</a>`;
        
        // Replace the placeholders with the original links (outside the task link)
        anchorMatches.forEach((anchor, index) => {
          // For external links, ensure they open in new tab
          const isExternal = /^https?:\/\//.test(anchor.href);
          const targetAttr = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
          wrappedContent = wrappedContent.replace(
            `__ANCHOR_${index}__`,
            `</a><a href="${anchor.href}"${targetAttr}>${anchor.linkText}</a><a href="/task/${taskId1}" style="text-decoration: none; color: inherit;" 
                  onmouseover="this.style.textDecoration='underline'" 
                  onmouseout="this.style.textDecoration='none'">`
          );
        });
        
        // Clean up any empty task links that might have been created
        wrappedContent = wrappedContent.replace(/<a[^>]*href="\/task\/[^"]*"[^>]*><\/a>/g, '');
        
        return `<li>${before}${checkbox} ${wrappedContent}<!-- task-id: ${taskId2} --></li>`;
      } else {
        // No existing links, wrap the entire content
        return `<li>${before}${checkbox} <a href="/task/${taskId1}" style="text-decoration: none; color: inherit;" 
                  onmouseover="this.style.textDecoration='underline'" 
                  onmouseout="this.style.textDecoration='none'">${cleanTaskContent}</a><!-- task-id: ${taskId2} --></li>`;
      }
    }
  );

  // Make regular markdown tasks with task-id comments clickable
  // Tasks are now rendered with links directly from the tasks table
  // No post-processing needed for task links

  const fileName = pageTitle || path.basename(urlPath);
  
  // Build breadcrumb
  const breadcrumbParts = urlPath ? urlPath.split('/').filter(Boolean) : [];
  let breadcrumbHtml = '<li class="breadcrumb-item"><a href="/"><i class="fas fa-home"></i></a></li>';
  let currentPath = '';
  breadcrumbParts.forEach((part, index) => {
    currentPath += '/' + part;
    if (index === breadcrumbParts.length - 1) {
      breadcrumbHtml += `<li class="breadcrumb-item active" aria-current="page">${part}</li>`;
    } else {
      breadcrumbHtml += `<li class="breadcrumb-item"><a href="${currentPath}">${part}</a></li>`;
    }
  });
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>${fileName}</title>
      ${pageStyle}
    </head>
    <body>
      ${getNavbar(fileName, 'fa-file-alt')}

      <!-- Main content with chat -->
      <div class="container-fluid mt-3">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <!-- Time Tracking -->
        ${getTimerWidget(currentTimer)}

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-md-7 mb-3">
            <div class="card shadow-sm">
              <div class="card-header bg-white border-bottom">
                <div class="d-flex justify-content-between align-items-center">
                  <h5 class="mb-0">${pageTitle || fileName}</h5>
                  <a href="/edit/${urlPath}" class="btn btn-primary btn-sm">
                    <i class="fas fa-edit me-1"></i>Edit
                  </a>
                </div>
                ${toc ? `<div class="mt-2 pt-2 border-top">${toc}</div>` : ''}
              </div>
              <div class="card-body markdown-content">
                ${renderProperties(properties)}
                ${htmlContent}
              </div>
            </div>
          </div>
          
          <!-- Chat column -->
          <div class="col-12 col-md-5 mb-3">
            ${getAIAssistantPanel('Start a conversation about this document')}
          </div>
        </div>
      </div>

      ${getFloatingToggleBtn()}

      ${pageScriptsWithMarked}

      <script>
        // Page-specific: Chat functionality
        checkChatVersion(); // Page will reload if version changed

        let chatHistory = [];
        let inputHistory = JSON.parse(localStorage.getItem('inputHistory') || '[]');
        let historyIndex = -1;
        const chatStorageKey = 'chatHistory_${urlPath}';
        const chatApiPath = '${urlPath}';

        // Load existing chat messages (from server first, then localStorage fallback)
        async function loadChatHistory() {
          const chatMessages = document.getElementById('chatMessages');

          // Try to load from server first
          try {
            const response = await fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`);
            if (response.ok) {
              const data = await response.json();
              if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                // Also update localStorage as backup
                localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
              }
            }
          } catch (e) {
            console.log('Failed to load chat from server, falling back to localStorage');
          }

          // Fall back to localStorage if no server data
          if (chatHistory.length === 0) {
            chatHistory = JSON.parse(localStorage.getItem(chatStorageKey) || '[]');
          }

          if (chatHistory.length > 0) {
            chatMessages.innerHTML = '';
            chatHistory.forEach(msg => {
              addChatBubble(msg.content, msg.role, false);
            });
          }
        }

        // Save conversation to server
        async function saveConversationToServer() {
          try {
            await fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: chatHistory })
            });
          } catch (e) {
            console.log('Failed to save conversation to server');
          }
        }

        // Add a chat bubble to the interface
        function addChatBubble(message, role, save = true, replyTime = null) {
          const chatMessages = document.getElementById('chatMessages');
          const bubble = document.createElement('div');
          bubble.className = \`chat-bubble \${role}\`;

          const timestamp = new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });

          // Render markdown using marked with external link renderer
          const renderedContent = marked.parse(message, { renderer: createExternalLinkRenderer() });

          let bubbleHtml = \`
            <div class="bubble-content">
              <small class="d-block chat-timestamp">
                \${role === 'user' ? 'You' : 'AI'} · \${timestamp}
              </small>
              <div class="markdown-content">\${renderedContent}</div>
          \`;

          if (replyTime) {
            bubbleHtml += \`<small class="d-block mt-1 chat-timestamp-subtle">Replied in \${replyTime}</small>\`;
          }

          bubbleHtml += \`</div>\`;
          bubble.innerHTML = bubbleHtml;

          chatMessages.appendChild(bubble);
          chatMessages.scrollTop = chatMessages.scrollHeight;

          if (save) {
            chatHistory.push({
              role: role,
              content: message,
              timestamp: new Date().toISOString()
            });
            localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
            saveConversationToServer();
          }
        }

        // Send message to AI
        async function sendMessage() {
          const input = document.getElementById('chatInput');
          const message = input.value.trim();

          if (!message) return;

          // Handle /clear command
          if (message === '/clear') {
            chatHistory = [];
            localStorage.removeItem(chatStorageKey);
            // Also clear on server
            fetch(\`/api/ai-chat/conversations/\${chatApiPath}\`, { method: 'DELETE' }).catch(() => {});
            document.getElementById('chatMessages').innerHTML = \`
              <div class="text-center text-muted p-3">
                <small>Conversation cleared. Start fresh!</small>
              </div>
            \`;
            input.value = '';
            return;
          }
          
          // Add to input history
          inputHistory.unshift(message);
          inputHistory = inputHistory.slice(0, 50); // Keep last 50
          localStorage.setItem('inputHistory', JSON.stringify(inputHistory));
          historyIndex = -1;
          
          // Add user message
          addChatBubble(message, 'user');
          input.value = '';
          
          // Show typing indicator with timer
          const typingIndicator = document.createElement('div');
          typingIndicator.className = 'chat-bubble assistant typing-indicator';
          const startTime = Date.now();
          
          // Create initial HTML with space for thinking content
          typingIndicator.innerHTML = \`
            <div class="bubble-content">
              <small class="d-block chat-timestamp">AI · Processing...</small>
              <div class="d-flex align-items-center">
                <div class="spinner-border spinner-border-sm text-secondary me-2" role="status">
                  <span class="visually-hidden">Loading...</span>
                </div>
                <span class="text-muted" id="ai-timer">0 seconds</span>
              </div>
              <div class="thinking-content-display text-muted small mt-2" style="display: none;"></div>
            </div>
          \`;
          document.getElementById('chatMessages').appendChild(typingIndicator);
          
          // Update timer every second
          const timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const timerElement = document.getElementById('ai-timer');
            if (timerElement) {
              if (elapsed < 60) {
                timerElement.textContent = \`\${elapsed} second\${elapsed !== 1 ? 's' : ''}\`;
              } else {
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                timerElement.textContent = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
              }
            } else {
              clearInterval(timerInterval);
            }
          }, 1000);
          
          try {
            // Get the markdown content
            const markdownContent = document.querySelector('.markdown-content').innerText || '';
            
            // Create a container for thinking content that will be collapsed
            let thinkingContainer = null;
            let thinkingContent = '';
            let responseContent = '';
            let responseStarted = false;
            let lastToolError = null;
            
            // Use fetch with streaming response for SSE
            const response = await fetch(\`/ai-chat-stream/${urlPath}\`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: message,
                history: chatHistory,
                documentContent: markdownContent
              })
            });
            
            if (!response.ok) {
              throw new Error('Failed to connect to streaming endpoint');
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\\n');
              buffer = lines.pop(); // Keep incomplete line in buffer
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'thinking') {
                      // Update thinking indicator
                      thinkingContent += data.content;
                      const thinkingElement = typingIndicator.querySelector('.thinking-content');
                      if (thinkingElement) {
                        thinkingElement.style.display = 'block';
                        thinkingElement.textContent = thinkingContent.slice(-200); // Show last 200 chars
                        // Update label to show we're seeing thinking
                        const labelElement = typingIndicator.querySelector('small');
                        if (labelElement) {
                          labelElement.textContent = 'AI · Thinking...';
                        }
                      }
                    } else if (data.type === 'thinking-complete') {
                      // Thinking is done, prepare to show response
                      thinkingContent = data.content;
                    } else if (data.type === 'status') {
                      // Update status message in typing indicator
                      const labelElement = typingIndicator.querySelector('small');
                      if (labelElement) {
                        labelElement.textContent = 'AI · ' + data.message;
                      }
                    } else if (data.type === 'tool-call') {
                      // Show tool being called
                      const labelElement = typingIndicator.querySelector('small');
                      if (labelElement) {
                        const toolDisplayName = {
                          'edit_file': 'Editing file',
                          'query_database': 'Querying database',
                          'run_command': 'Running command'
                        }[data.toolName] || 'Using ' + data.toolName;
                        labelElement.textContent = 'AI · ' + toolDisplayName + '...';
                      }
                    } else if (data.type === 'tool-result') {
                      // Tool completed, update status and store any error
                      const labelElement = typingIndicator.querySelector('small');
                      const success = data.result && data.result.success !== false;
                      if (!success && data.result) {
                        // Store tool error for display if AI doesn't respond
                        lastToolError = data.result.error || 'Tool execution failed';
                      }
                      if (labelElement) {
                        labelElement.textContent = 'AI · ' + (success ? 'Processing result...' : 'Tool returned error');
                      }
                    } else if (data.type === 'text') {
                      if (!responseStarted) {
                        // First text chunk - remove typing indicator
                        clearInterval(timerInterval);
                        typingIndicator.remove();
                        
                        // If we have thinking content, create collapsible section
                        if (thinkingContent) {
                          const thinkingId = 'thinking-' + Date.now();
                          const thinkingHtml = \`
                            <div class="chat-bubble assistant">
                              <div class="bubble-content">
                                <small class="d-block chat-timestamp-lg">AI · Thinking Process</small>
                                <details class="mb-2">
                                  <summary class="text-muted small" style="cursor: pointer;">
                                    <i class="fas fa-brain me-1"></i> View thinking process
                                  </summary>
                                  <div class="thinking-result mt-2 p-2 bg-light rounded">
                                    \${escapeHtml(thinkingContent)}
                                  </div>
                                </details>
                              </div>
                            </div>
                          \`;
                          
                          const tempDiv = document.createElement('div');
                          tempDiv.innerHTML = thinkingHtml;
                          thinkingContainer = tempDiv.firstChild;
                          document.getElementById('chatMessages').appendChild(thinkingContainer);
                        }
                        
                        // Create response bubble
                        const responseBubble = document.createElement('div');
                        responseBubble.className = 'chat-bubble assistant';
                        responseBubble.id = 'streaming-response';
                        responseBubble.innerHTML = \`
                          <div class="bubble-content">
                            <small class="d-block chat-timestamp-lg">AI · <span id="response-timer">Responding...</span></small>
                            <div class="response-text"></div>
                          </div>
                        \`;
                        document.getElementById('chatMessages').appendChild(responseBubble);
                        responseStarted = true;
                      }
                      
                      // Append text to response
                      responseContent += data.content;
                      const responseElement = document.querySelector('#streaming-response .response-text');
                      if (responseElement) {
                        responseElement.innerHTML = marked.parse(responseContent, { renderer: createExternalLinkRenderer() });
                      }
                      
                      // Scroll to bottom
                      const chatMessages = document.getElementById('chatMessages');
                      chatMessages.scrollTop = chatMessages.scrollHeight;
                    } else if (data.type === 'done') {
                      // Calculate response time
                      const responseTime = Math.floor((Date.now() - startTime) / 1000);
                      let timeStr;
                      if (responseTime < 60) {
                        timeStr = responseTime + ' second' + (responseTime !== 1 ? 's' : '');
                      } else {
                        const minutes = Math.floor(responseTime / 60);
                        const seconds = (responseTime % 60).toString().padStart(2, '0');
                        timeStr = minutes + ':' + seconds;
                      }

                      // If no text response was received, handle gracefully
                      if (!responseStarted) {
                        clearInterval(timerInterval);
                        typingIndicator.remove();

                        // Show tool error or generic message
                        let errorMsg = lastToolError
                          ? 'Tool error: ' + lastToolError
                          : 'The AI completed without providing a text response.';

                        // If file was modified despite error, mention it
                        if (data.fileModified) {
                          errorMsg = 'The file was modified, but the AI did not provide a response. ' + (lastToolError || '');
                        }

                        addChatBubble(errorMsg, 'assistant', true, timeStr);

                        // Still save to history so we don't lose context
                        chatHistory.push(
                          { role: 'user', content: message, timestamp: new Date().toISOString() },
                          { role: 'assistant', content: errorMsg, timestamp: new Date().toISOString() }
                        );
                        localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
                        saveConversationToServer();

                        if (data.fileModified) {
                          refreshContentArea();
                        }
                        return;
                      }

                      // Update timer in response
                      const timerElement = document.getElementById('response-timer');
                      if (timerElement) {
                        timerElement.textContent = 'Replied in ' + timeStr;
                      }

                      // Save to chat history
                      chatHistory.push(
                        { role: 'user', content: message, timestamp: new Date().toISOString() },
                        { role: 'assistant', content: data.fullResponse || responseContent, timestamp: new Date().toISOString() }
                      );
                      localStorage.setItem(chatStorageKey, JSON.stringify(chatHistory));
                      saveConversationToServer();

                      // If file was modified, refresh the content area
                      if (data.fileModified) {
                        refreshContentArea();
                      }
                    } else if (data.type === 'error') {
                      throw new Error(data.message);
                    }
                  } catch (error) {
                    console.error('Error parsing SSE data:', error);
                  }
                }
              }
            }
            
          } catch (error) {
            console.error('Error sending message:', error);
            clearInterval(timerInterval);
            typingIndicator.remove();
            
            // Calculate how long it took to fail
            const responseTime = Math.floor((Date.now() - startTime) / 1000);
            let timeStr;
            if (responseTime < 60) {
              timeStr = responseTime + ' second' + (responseTime !== 1 ? 's' : '');
            } else {
              const minutes = Math.floor(responseTime / 60);
              const seconds = (responseTime % 60).toString().padStart(2, '0');
              timeStr = minutes + ':' + seconds;
            }
            
            let errorMessage = 'Sorry, I encountered an error. ';
            if (error.message) {
              errorMessage += error.message;
            } else {
              errorMessage += 'Please try again.';
            }
            
            // Add error with timing info (note: replyTime parameter shows as "Replied in X")
            addChatBubble(errorMessage, 'assistant', true, timeStr + ' (failed)');
          }
        }
        
        // Handle input history with arrow keys
        document.getElementById('chatInput').addEventListener('keydown', function(e) {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex < inputHistory.length - 1) {
              historyIndex++;
              this.value = inputHistory[historyIndex];
            }
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex > 0) {
              historyIndex--;
              this.value = inputHistory[historyIndex];
            } else if (historyIndex === 0) {
              historyIndex = -1;
              this.value = '';
            }
          }
        });
        
        // Load chat history on page load
        loadChatHistory();
        
        // Function to refresh just the content area
        async function refreshContentArea() {
          try {
            // Fetch the current page again
            const response = await fetch(window.location.href);
            if (!response.ok) throw new Error('Failed to fetch updated content');
            
            const html = await response.text();
            const parser = new DOMParser();
            const newDoc = parser.parseFromString(html, 'text/html');
            
            // Find the new content
            const newContent = newDoc.querySelector('.card-body.markdown-content');
            const currentContent = document.querySelector('.card-body.markdown-content');
            
            if (newContent && currentContent) {
              // Preserve scroll position
              const scrollTop = currentContent.scrollTop;
              
              // Replace the content
              currentContent.innerHTML = newContent.innerHTML;
              
              // Restore scroll position
              currentContent.scrollTop = scrollTop;
              
              // Re-attach checkbox handlers (but not for task-checkbox which uses event delegation)
              currentContent.querySelectorAll('input[type="checkbox"]:not(.task-checkbox)').forEach(checkbox => {
                checkbox.onchange = function(e) {
                  // Get taskId from dataset if available
                  const taskId = this.dataset.taskId || null;
                  toggleCheckbox(this, parseInt(this.dataset.line), taskId, e);
                };
              });
              
              // Re-attach details/summary handlers
              currentContent.querySelectorAll('details').forEach(details => {
                details.addEventListener('toggle', function(e) {
                  e.stopPropagation();
                });
              });
              
              // Show notification
              const notification = document.createElement('div');
              notification.className = 'alert alert-success alert-dismissible fade show position-fixed';
              notification.style.cssText = 'top: 70px; right: 20px; z-index: 1050; max-width: 300px;';
              notification.innerHTML = \`
                <i class="fas fa-check-circle me-2"></i>
                Content refreshed
                <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
              \`;
              document.body.appendChild(notification);
              
              // Auto-dismiss after 3 seconds
              setTimeout(() => {
                notification.remove();
              }, 3000);
            }
          } catch (error) {
            console.error('Error refreshing content:', error);
          }
        }
        
        // No longer needed - using inline onclick handlers
        
        // This function is now deprecated - event delegation handles all checkboxes
        // Kept only for backwards compatibility during transition
        function toggleCheckbox(checkbox, lineNumber, taskId, event) {
          // Do nothing - let event delegation handle it
          return;
        }
        
        // Add interactivity to task checkboxes using event delegation
        document.addEventListener('DOMContentLoaded', function() {
          console.log('DOMContentLoaded - Setting up event handlers');

          // Auto-collapse TOC when clicking a link - use event delegation
          document.addEventListener('click', function(event) {
            // Check if the clicked element is a link inside the TOC
            const link = event.target.closest('details.toc-header a');
            if (link) {
              // Find the parent details element
              const tocHeader = link.closest('details.toc-header');
              if (tocHeader) {
                // Collapse the TOC immediately when link is clicked
                // Use requestAnimationFrame to ensure it happens after the browser processes the click
                requestAnimationFrame(() => {
                  tocHeader.open = false;
                });
              }
            }
          });

          // Use event delegation to handle dynamically added checkboxes
          console.log('Adding change event listener');
          document.addEventListener('change', async function(event) {
            console.log('Change event fired:', event.target.className, event.target);
            if (!event.target.classList.contains('task-checkbox')) {
              console.log('Not a task checkbox, ignoring');
              return;
            }

            const checkbox = event.target;
            const filePath = checkbox.dataset.file;
            const lineNumber = checkbox.dataset.line;
            const isChecked = checkbox.checked;

            console.log('Task checkbox clicked:', { filePath, lineNumber, isChecked });

            // Disable checkbox during update
            checkbox.disabled = true;

              try {
                const response = await fetch('/task/toggle', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                  credentials: 'same-origin',  // Include cookies for authentication
                  body: JSON.stringify({
                    filePath: filePath,
                    lineNumber: parseInt(lineNumber, 10),
                    completed: isChecked
                  })
                });

                if (!response.ok) {
                  throw new Error('Failed to update task');
                }

                const result = await response.json();

                // Visual feedback
                const listItem = checkbox.closest('li');
                if (listItem) {
                  listItem.style.transition = 'opacity 0.3s';
                  listItem.style.opacity = '0.5';
                  setTimeout(() => {
                    listItem.style.opacity = '1';
                  }, 300);
                }

                // If task was marked complete, update the display
                if (isChecked && result.updatedLine) {
                  // Find the parent li element and update its text content
                  const listItem = checkbox.closest('li');
                  if (listItem) {
                    const today = new Date().toISOString().split('T')[0];
                    // Get all the text content after the checkbox
                    const allText = Array.from(listItem.childNodes)
                      .filter(node => node !== checkbox && node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE)
                      .map(node => node.textContent)
                      .join('')
                      .trim();

                    // If there's no completion date, add it
                    if (!allText.includes('✅')) {
                      // Clear the list item except for the checkbox
                      while (listItem.lastChild && listItem.lastChild !== checkbox) {
                        listItem.removeChild(listItem.lastChild);
                      }
                      // Add a space after the checkbox
                      listItem.appendChild(document.createTextNode(' '));
                      // Add the text with completion date
                      listItem.appendChild(document.createTextNode(allText + ' ✅ ' + today));
                    }
                  }
                } else if (!isChecked) {
                  // If unchecking, remove the completion date
                  const listItem = checkbox.closest('li');
                  if (listItem) {
                    // Get all the text content after the checkbox
                    const allText = Array.from(listItem.childNodes)
                      .filter(node => node !== checkbox && node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE)
                      .map(node => node.textContent)
                      .join('')
                      .trim();

                    // Remove completion date if present
                    const cleanedText = allText.replace(/ ✅ \d{4}-\d{2}-\d{2}$/, '');
                    if (cleanedText !== allText) {
                      // Clear the list item except for the checkbox
                      while (listItem.lastChild && listItem.lastChild !== checkbox) {
                        listItem.removeChild(listItem.lastChild);
                      }
                      // Add a space after the checkbox
                      listItem.appendChild(document.createTextNode(' '));
                      // Add the cleaned text
                      listItem.appendChild(document.createTextNode(cleanedText));
                    }
                  }
                }
              } catch (error) {
                console.error('Error updating task:', error);
                // Revert checkbox state on error
                checkbox.checked = !isChecked;
                alert('Failed to update task. Please try again.');
              } finally {
                // Re-enable checkbox
                checkbox.disabled = false;
              }
          });
        });

        // Track page visits for recents
        const currentPath = window.location.pathname;
        if (currentPath !== '/' && currentPath !== '') {
          let recentPages = JSON.parse(localStorage.getItem('recentPages') || '[]');

          // Remove current page if it exists in the list
          recentPages = recentPages.filter(page => page.path !== currentPath);

          // Add current page to the beginning
          const pageTitle = document.title;
          recentPages.unshift({
            path: currentPath,
            title: pageTitle,
            timestamp: new Date().toISOString()
          });

          // Keep only the 10 most recent
          recentPages = recentPages.slice(0, 10);

          localStorage.setItem('recentPages', JSON.stringify(recentPages));
        }
      </script>
    </body>
    </html>
  `;

  debug('HTML includes chatMessages:', html.includes('chatMessages'));
  return html;
}

// New cached renderMarkdown function that replaces the original
async function renderMarkdown(filePath, urlPath) {
  return getCachedRender(filePath, urlPath);
}

// Cache status endpoint
app.get('/_cache/status', sessionAuth, (req, res) => {
  const cacheStats = {
    size: renderCache.size,
    maxSize: CACHE_MAX_SIZE,
    ttl: CACHE_TTL / 1000 / 60, // Convert to minutes
    entries: []
  };
  
  // Get cache entries with stats
  for (const [key, value] of renderCache.entries()) {
    const stats = fileStatsCache.get(key);
    cacheStats.entries.push({
      path: key.replace(VAULT_PATH, ''),
      hits: value.hits || 0,
      age: Math.floor((Date.now() - value.timestamp) / 1000), // seconds
      size: stats ? stats.size : 0
    });
  }
  
  // Sort by hits descending
  cacheStats.entries.sort((a, b) => b.hits - a.hits);
  
  res.json(cacheStats);
});

// Clear cache endpoint
app.post('/_cache/clear', sessionAuth, (req, res) => {
  const previousSize = renderCache.size;
  renderCache.clear();
  fileStatsCache.clear();
  
  res.json({
    success: true,
    message: `Cache cleared. Removed ${previousSize} entries.`
  });
});

// File edit endpoint for AI
app.post('/ai-edit/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
    const fullPath = path.join(VAULT_PATH, urlPath);
    const { content } = req.body;
    
    // Security check
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Write the file
    await fs.writeFile(fullPath, content, 'utf-8');
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error editing file:', error);
    res.status(500).json({ error: 'Failed to edit file' });
  }
});

// AI Chat route handler (non-streaming, uses ai-chat module)
app.post('/ai-chat/*path', authMiddleware, async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const { message, history: rawHistory } = req.body;
    // Filter out empty messages - Anthropic API rejects them
    const history = (rawHistory || []).filter(msg => msg.content && msg.content.trim());
    const fullPath = path.join(VAULT_PATH, urlPath);

    // Read the actual file content from disk (not from client)
    let documentContent = '';
    try {
      documentContent = await fs.readFile(fullPath, 'utf-8');
    } catch (e) {
      debug('[AI Chat] Could not read file:', fullPath, e.message);
    }

    // Get initial file modification time
    let initialMtime = null;
    try {
      const stats = await fs.stat(fullPath);
      initialMtime = stats.mtimeMs;
    } catch (e) {
      // File might not exist or be accessible
    }

    debug('[AI Chat] Starting chat with provider:', getChatProviderName());

    try {
      const response = await chatWithFile({
        urlPath,
        message,
        history,
        documentContent,
        stream: false,
      });

      // Check if file was modified
      let fileModified = false;
      if (initialMtime !== null) {
        try {
          const newStats = await fs.stat(fullPath);
          fileModified = newStats.mtimeMs !== initialMtime;
        } catch (e) {
          // File might have been deleted or become inaccessible
        }
      }

      res.json({
        response: response.trim(),
        fileModified,
      });
    } catch (error) {
      debug('[AI Chat] Error:', error);

      let errorResponse = "I'm having trouble processing your request.";
      if (error.message && error.message.includes('timed out')) {
        errorResponse = "The AI request took too long. Please try a shorter or simpler question.";
      } else if (error.message) {
        errorResponse = "The AI service encountered an error. Please try again in a moment.";
      }

      res.json({ response: errorResponse });
    }
  } catch (error) {
    console.error('Error in AI chat:', error);
    res.status(500).json({
      success: false,
      response: 'An error occurred while processing your request.'
    });
  }
});

// SSE endpoint for streaming AI chat responses (uses ai-chat module)
app.post('/ai-chat-stream/*path', authMiddleware, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Timeout for the entire stream (2 minutes)
  const STREAM_TIMEOUT_MS = 120000;
  let timeoutId = null;
  let isAborted = false;

  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  const cleanup = () => {
    clearInterval(keepAlive);
    if (timeoutId) clearTimeout(timeoutId);
  };

  req.on('close', () => {
    isAborted = true;
    cleanup();
  });

  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const { message, history: rawHistory } = req.body;
    // Filter out empty messages - Anthropic API rejects them
    const history = (rawHistory || []).filter(msg => msg.content && msg.content.trim());
    const fullPath = path.join(VAULT_PATH, urlPath);

    // Read the actual file content from disk (not from client)
    let documentContent = '';
    try {
      documentContent = await fs.readFile(fullPath, 'utf-8');
    } catch (e) {
      debug('[AI Stream] Could not read file:', fullPath, e.message);
    }

    // Get initial file modification time
    let initialMtime = null;
    try {
      const stats = await fs.stat(fullPath);
      initialMtime = stats.mtimeMs;
    } catch (e) {
      // File might not exist or be accessible
    }

    // Create tools for this chat session
    const tools = createChatTools({
      filePath: fullPath,
      includeEdit: true,
      includeDatabase: true,
      includeCommands: true,
    });

    debug('[AI Stream] Starting streaming chat with provider:', getChatProviderName(), 'tools:', tools ? Object.keys(tools) : 'none');

    // Send initial status
    res.write(`data: ${JSON.stringify({
      type: 'status',
      message: 'Connecting to AI...'
    })}\n\n`);

    try {
      // Set up timeout that covers the entire operation
      timeoutId = setTimeout(() => {
        if (!isAborted) {
          isAborted = true;
          console.error('[AI Stream] Request timed out after 2 minutes');
          res.write(`data: ${JSON.stringify({
            type: 'error',
            message: 'Request timed out after 2 minutes. The AI may be having trouble with this request.'
          })}\n\n`);
          cleanup();
          res.end();
        }
      }, STREAM_TIMEOUT_MS);

      console.log('[AI Stream] Calling chatWithFile, history length:', history?.length || 0);
      const streamResult = await chatWithFile({
        urlPath,
        message,
        history,
        documentContent,
        stream: true,
        tools,
      });
      console.log('[AI Stream] Got streamResult, starting to iterate fullStream');

      if (isAborted) {
        cleanup();
        return;
      }

      let fullResponse = '';
      const toolCalls = [];
      let partCount = 0;
      const partTypes = new Set();

      // Use fullStream to handle both text and tool calls
      for await (const part of streamResult.fullStream) {
        partCount++;
        partTypes.add(part.type);
        if (partCount <= 10 || part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'error') {
          console.log('[AI Stream] Part', partCount, 'type:', part.type, 'keys:', Object.keys(part));
        }
        if (isAborted) break;

        if (part.type === 'start-step') {
          console.log('[AI Stream] New step starting');
        } else if (part.type === 'finish-step') {
          console.log('[AI Stream] Step finished');
        } else if (part.type === 'text-delta') {
          const text = part.text ?? part.textDelta ?? '';
          if (text) {
            fullResponse += text;
            res.write(`data: ${JSON.stringify({
              type: 'text',
              content: text
            })}\n\n`);
          }
        } else if (part.type === 'tool-call') {
          // Notify client that a tool is being called
          debug('[AI Stream] Tool call:', part.toolName, part.args);
          res.write(`data: ${JSON.stringify({
            type: 'tool-call',
            toolName: part.toolName,
            args: part.args
          })}\n\n`);
          toolCalls.push({ name: part.toolName, args: part.args });
        } else if (part.type === 'tool-result') {
          // Notify client of tool result (SDK uses 'output' not 'result')
          const result = part.output ?? part.result;
          const resultPreview = typeof result === 'object'
            ? JSON.stringify(result).slice(0, 200)
            : String(result).slice(0, 200);
          console.log('[AI Stream] Tool result:', part.toolName, resultPreview);
          res.write(`data: ${JSON.stringify({
            type: 'tool-result',
            toolName: part.toolName,
            result: result
          })}\n\n`);
        } else if (part.type === 'error') {
          // AI provider returned an error
          const errorMessage = part.error?.message || part.error?.toString() || 'Unknown AI error';
          console.error('[AI Stream] Provider error:', errorMessage);
          res.write(`data: ${JSON.stringify({
            type: 'error',
            message: errorMessage
          })}\n\n`);
          cleanup();
          res.end();
          return;
        }
      }

      console.log('[AI Stream] Stream ended, total parts:', partCount, 'response length:', fullResponse.length, 'part types:', Array.from(partTypes));

      if (isAborted) {
        cleanup();
        return;
      }

      // Check if file was modified
      let fileModified = false;
      if (initialMtime !== null) {
        try {
          const newStats = await fs.stat(fullPath);
          fileModified = newStats.mtimeMs !== initialMtime;
        } catch (e) {
          // File might have been deleted or become inaccessible
        }
      }

      // Send completion signal
      res.write(`data: ${JSON.stringify({
        type: 'done',
        fileModified,
        fullResponse,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      })}\n\n`);

      cleanup();
      res.end();
    } catch (error) {
      console.error('[AI Stream] Error:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: error.message || 'An error occurred'
      })}\n\n`);
      cleanup();
      res.end();
    }
  } catch (error) {
    console.error('[AI Stream] Error:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: error.message
    })}\n\n`);
    cleanup();
    res.end();
  }
});

// AI Chat route handler for directories (uses ai-chat module)
app.post('/ai-chat-directory/*path', authMiddleware, async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const { message, history, directoryContext } = req.body;

    debug('[AI Directory Chat] Starting chat with provider:', getChatProviderName());

    try {
      const response = await chatWithDirectory({
        urlPath,
        message,
        history,
        directoryContext,
      });

      res.json({ response: response.trim() });
    } catch (error) {
      console.error('[AI Directory Chat] Error:', error);

      let errorResponse = "I'm having trouble processing your request.";
      if (error.message && error.message.includes('timed out')) {
        errorResponse = "The AI request took too long. Please try a shorter or simpler question.";
      } else if (error.message) {
        errorResponse = "The AI service encountered an error. Please try again in a moment.";
      }

      res.json({ response: errorResponse });
    }
  } catch (error) {
    console.error('Error in AI directory chat:', error);
    res.status(500).json({
      success: false,
      response: 'An error occurred while processing your request.'
    });
  }
});

// GET conversation history from vault
app.get('/api/ai-chat/conversations/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const messages = await loadConversation(urlPath);
    res.json({ messages });
  } catch (error) {
    console.error('Error loading conversation:', error);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// PUT (save) conversation to vault
app.put('/api/ai-chat/conversations/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const { messages } = req.body;
    await saveConversation(urlPath, messages || []);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving conversation:', error);
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// DELETE conversation from vault
app.delete('/api/ai-chat/conversations/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
    const deleted = await clearConversation(urlPath);
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error clearing conversation:', error);
    res.status(500).json({ error: 'Failed to clear conversation' });
  }
});

// Search route handler
app.get('/search', authMiddleware, async (req, res) => {
  try {
    const searchQuery = req.query.q || '';
    
    if (!searchQuery) {
      return res.redirect('/');
    }
    
    // Use grep to search for the query in markdown files
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      // Search in file contents (excluding hidden directories)
      const { stdout: contentResults } = await execAsync(
        `grep -r -i -l --include="*.md" --exclude-dir=".*" "${searchQuery.replace(/"/g, '\\"')}" "${VAULT_PATH}" | head -100`,
        { maxBuffer: 1024 * 1024 * 10 } // 10MB buffer
      );

      // Search in filenames (excluding hidden files and directories)
      const { stdout: filenameResults } = await execAsync(
        `find "${VAULT_PATH}" -type f -name "*.md" ! -path "*/.*" -iname "*${searchQuery.replace(/"/g, '\\"')}*" | head -100`,
        { maxBuffer: 1024 * 1024 * 10 }
      );
      
      // Combine and deduplicate results
      const allFiles = new Set();
      
      if (contentResults) {
        contentResults.split('\n').filter(f => f).forEach(file => {
          allFiles.add(file);
        });
      }
      
      if (filenameResults) {
        filenameResults.split('\n').filter(f => f).forEach(file => {
          allFiles.add(file);
        });
      }
      
      // Convert to relative paths and create result objects
      const results = [];
      for (const file of allFiles) {
        const relativePath = path.relative(VAULT_PATH, file);
        const fileName = path.basename(file);
        
        // Try to get snippet of matching content
        let snippet = '';
        try {
          const { stdout } = await execAsync(
            `grep -i -m 1 -C 1 "${searchQuery.replace(/"/g, '\\"')}" "${file}"`,
            { maxBuffer: 1024 * 1024 }
          );
          snippet = stdout.trim().replace(/\n/g, ' ').substring(0, 200);
        } catch (e) {
          // No match in content, might be filename match
        }
        
        results.push({
          path: relativePath,
          fileName: fileName,
          snippet: snippet
        });
      }
      
      // Sort results - filename matches first
      results.sort((a, b) => {
        const aHasFilenameMatch = a.fileName.toLowerCase().includes(searchQuery.toLowerCase());
        const bHasFilenameMatch = b.fileName.toLowerCase().includes(searchQuery.toLowerCase());
        if (aHasFilenameMatch && !bHasFilenameMatch) return -1;
        if (!aHasFilenameMatch && bHasFilenameMatch) return 1;
        return a.fileName.localeCompare(b.fileName);
      });
      
      // Render search results page
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Search: ${searchQuery}</title>
          ${pageStyle}
        </head>
        <body>
          ${getNavbar('Search Results', 'fa-search', { searchValue: searchQuery })}
          
          <div class="container-fluid mt-3">
            <div class="row">
              <div class="col">
                <div class="card shadow-sm">
                  <div class="card-header">
                    <h5 class="mb-0">
                      <i class="fas fa-search me-2"></i>
                      Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${searchQuery}"
                    </h5>
                  </div>
                  <div class="list-group list-group-flush">
                    ${results.length === 0 ? `
                      <div class="list-group-item text-muted text-center py-4">
                        No results found. Try a different search term.
                      </div>
                    ` : results.map(result => `
                      <a href="/${result.path}" class="list-group-item list-group-item-action">
                        <div class="d-flex w-100 justify-content-between">
                          <h6 class="mb-1">
                            <i class="fas fa-file-alt text-info me-2"></i>
                            ${result.fileName}
                          </h6>
                        </div>
                        <p class="mb-1 text-muted small">${result.path}</p>
                        ${result.snippet ? `
                          <small class="text-muted">
                            ...${result.snippet}...
                          </small>
                        ` : ''}
                      </a>
                    `).join('')}
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          ${pageScripts}
        </body>
        </html>
      `;

      res.send(html);
      
    } catch (error) {
      console.error('Search error:', error);
      
      // Return empty results on error
      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <title>Search: ${searchQuery}</title>
          ${pageStyle}
        </head>
        <body>
          ${getNavbar('Search Results', 'fa-search', { searchValue: searchQuery })}
          
          <div class="container-fluid mt-3">
            <div class="row">
              <div class="col">
                <div class="card shadow-sm">
                  <div class="card-header">
                    <h5 class="mb-0">
                      <i class="fas fa-search me-2"></i>
                      Search Results for "${searchQuery}"
                    </h5>
                  </div>
                  <div class="list-group list-group-flush">
                    <div class="list-group-item text-muted text-center py-4">
                      An error occurred while searching. Please try again.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          ${pageScripts}
        </body>
        </html>
      `;

      res.send(html);
    }
    
  } catch (error) {
    console.error('Error in search handler:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Edit route handler
app.get('/edit/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).send('Access denied');
    }
    
    // Check if file exists and is a markdown file
    const stats = await fs.stat(fullPath);
    if (!stats.isFile() || !fullPath.endsWith('.md')) {
      return res.status(400).send('Can only edit markdown files');
    }
    
    const html = await renderEditor(fullPath, urlPath);
    res.send(html);
  } catch (error) {
    console.error('Error in edit route:', error);
    res.status(404).send('File not found');
  }
});

// Toggle checkbox route handler
app.post('/toggle-checkbox/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).send('Access denied');
    }
    
    // Check if file exists and is a markdown file
    const stats = await fs.stat(fullPath);
    if (!stats.isFile() || !fullPath.endsWith('.md')) {
      return res.status(400).send('Can only toggle checkboxes in markdown files');
    }
    
    // Read the file
    let content = await fs.readFile(fullPath, 'utf-8');
    const { lineNumber, taskId: providedTaskId, checked } = req.body;
    
    // Split into lines
    const lines = content.split('\n');
    
    // Find the line to toggle - prioritize task ID if provided
    let targetLineNumber = lineNumber;
    let taskId = providedTaskId;
    
    if (providedTaskId) {
      // Find line by task ID
      const taskIdPattern = new RegExp(`<![-—]+ task-id: ${providedTaskId} [-—]+>`);
      const foundIndex = lines.findIndex(line => taskIdPattern.test(line));
      if (foundIndex !== -1) {
        targetLineNumber = foundIndex;
      }
    }
    
    // Find and toggle the checkbox on the specified line
    if (targetLineNumber >= 0 && targetLineNumber < lines.length) {
      const line = lines[targetLineNumber];
      
      // Extract task ID if not provided
      if (!taskId) {
        const taskIdMatch = line.match(/<![-—]+ task-id: ([a-f0-9]{32}) [-—]+>/);
        taskId = taskIdMatch ? taskIdMatch[1] : null;
      }
      
      // Match checkbox patterns: - [ ] or - [x] or - [X]
      if (checked) {
        // Check the box
        lines[targetLineNumber] = line.replace(/^(\s*)-\s*\[\s*\]\s*/, '$1- [x] ');
      } else {
        // Uncheck the box
        lines[targetLineNumber] = line.replace(/^(\s*)-\s*\[[xX]\]\s*/, '$1- [ ] ');
      }
      
      // Write back to file
      content = lines.join('\n');
      await fs.writeFile(fullPath, content, 'utf-8');
      
      // Task updates are now handled directly in markdown files
      // No database update needed with Obsidian Tasks approach
      
      // Schedule markdown regeneration to move completed tasks to proper sections
      if (urlPath.includes('tasks/') || urlPath.includes('projects/')) {
        scheduleMarkdownUpdate(fullPath);
      }
      
      console.log(`Checkbox toggled in: ${fullPath}, line ${targetLineNumber}${taskId ? ` (task: ${taskId})` : ''}`);
      res.json({ success: true, message: 'Checkbox toggled successfully' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid line number' });
    }
  } catch (error) {
    console.error('Error toggling checkbox:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle checkbox' });
  }
});

// Save route handler
// Helper function to calculate next recurrence date
function calculateNextRecurrence(pattern, fromDate) {
  // Parse patterns like:
  // - "every day" / "every 2 days" / "every 0.6 days"
  // - "every week" / "every 3 weeks"
  // - "every month" / "every 6 months"
  // - "every year" / "every 2 years"
  // - "every day when done" / "every 5 days when done"

  const baseDate = new Date(fromDate + 'T00:00:00');

  // Remove "when done" if present - it doesn't affect the calculation
  const cleanPattern = pattern.replace(/\s+when\s+done\s*$/i, '').trim();

  // Match the pattern
  const match = cleanPattern.match(/^every\s+(?:(\d+(?:\.\d+)?)\s+)?(day|days|week|weeks|month|months|year|years)$/i);

  if (!match) {
    console.error(`[TASK] Could not parse recurrence pattern: "${pattern}"`);
    return null;
  }

  const quantity = parseFloat(match[1] || '1');
  const unit = match[2].toLowerCase();

  // Calculate the next date
  const nextDate = new Date(baseDate);

  switch (unit) {
    case 'day':
    case 'days':
      nextDate.setDate(nextDate.getDate() + Math.round(quantity));
      break;
    case 'week':
    case 'weeks':
      nextDate.setDate(nextDate.getDate() + Math.round(quantity * 7));
      break;
    case 'month':
    case 'months':
      nextDate.setMonth(nextDate.getMonth() + Math.round(quantity));
      break;
    case 'year':
    case 'years':
      nextDate.setFullYear(nextDate.getFullYear() + Math.round(quantity));
      break;
    default:
      console.error(`[TASK] Unsupported recurrence unit: "${unit}"`);
      return null;
  }

  // Return in YYYY-MM-DD format
  return nextDate.toISOString().split('T')[0];
}

// Handle task checkbox toggling
app.post('/task/toggle', authMiddleware, async (req, res) => {
  try {
    const { filePath: file, lineNumber: line, completed } = req.body;
    debug(`[TASK] Toggling task - file: ${file}, line: ${line}, completed: ${completed}`);

    // Validate required fields
    if (!file || !line) {
      debug('[TASK] Missing required fields:', { file, line });
      return res.status(400).json({ error: 'Missing file path or line number' });
    }

    const filePath = path.join(VAULT_PATH, file);

    // For database queries, use relative path format (vault/...)
    const dbFilePath = path.join('vault', file);

    // Read the file first
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Get the task line (line numbers are 1-based)
    const taskLine = lines[line - 1];

    if (!taskLine) {
      debug(`[TASK] Line ${line} not found in file with ${lines.length} lines`);
      return res.status(400).json({ error: 'Task line not found' });
    }

    // Validate that this is actually a task line
    // Updated regex to match tasks in blockquotes too
    if (!taskLine.match(/^(?:\s*>)*\s*- \[[ xX]\]/)) {
      debug(`[TASK] Line ${line} is not a task: "${taskLine}"`);
      return res.status(400).json({ error: 'Not a task line' });
    }

    // Note: markdown_tasks cache was removed - proceeding with file version directly
    debug(`[TASK] Processing task from file: "${taskLine}"`);

    // Check if this is a recurring task (has 🔁 pattern)
    const recurringMatch = taskLine.match(/🔁\s+(.+?)(?:\s+(?:⏳|📅|➕)|$)/);
    const isRecurring = !!recurringMatch;
    let newTaskLine = null;

    // Update the task
    let updatedLine;
    if (completed) {
      // Mark as done and add completion date
      const today = new Date().toISOString().split('T')[0];
      updatedLine = taskLine
        .replace(/^((?:\s*>)*\s*)- \[ \]/, '$1- [x]')  // Keep any blockquote prefix
        .replace(/✅ \d{4}-\d{2}-\d{2}/, '') // Remove old completion date if exists
        + ` ✅ ${today}`;

      // If this is a recurring task, create the new occurrence
      if (isRecurring) {
        const recurrencePattern = recurringMatch[1].trim();
        debug(`[TASK] Processing recurring task with pattern: ${recurrencePattern}`);

        // Parse the recurrence pattern and calculate next date
        const nextDate = calculateNextRecurrence(recurrencePattern, today);

        if (nextDate) {
          // Create new task line by copying the original but with:
          // 1. Unchecked checkbox
          // 2. Updated scheduled date (⏳)
          // 3. No completion date
          newTaskLine = taskLine
            .replace(/^((?:\s*>)*\s*)- \[[ xX]\]/, '$1- [ ]')  // Unchecked
            .replace(/✅ \d{4}-\d{2}-\d{2}/, '');  // Remove any completion date

          // Update or add scheduled date (⏳)
          if (newTaskLine.includes('⏳')) {
            newTaskLine = newTaskLine.replace(/⏳ \d{4}-\d{2}-\d{2}/, `⏳ ${nextDate}`);
          } else {
            // Add scheduled date before any existing dates
            if (newTaskLine.includes('📅')) {
              newTaskLine = newTaskLine.replace(/📅/, `⏳ ${nextDate} 📅`);
            } else if (newTaskLine.includes('➕')) {
              newTaskLine = newTaskLine.replace(/➕/, `⏳ ${nextDate} ➕`);
            } else {
              newTaskLine = newTaskLine + ` ⏳ ${nextDate}`;
            }
          }

          // Preserve creation date if original task doesn't have one
          if (!newTaskLine.includes('➕') && !taskLine.includes('➕')) {
            // Add today as creation date for the new task
            newTaskLine = newTaskLine + ` ➕ ${today}`;
          }

          debug(`[TASK] Created new recurring task: ${newTaskLine}`);
        }
      }
    } else {
      // Mark as not done and remove completion date
      updatedLine = taskLine
        .replace(/^((?:\s*>)*\s*)- \[x\]/i, '$1- [ ]')  // Keep any blockquote prefix
        .replace(/ ✅ \d{4}-\d{2}-\d{2}/, '');
    }

    // Update the file
    lines[line - 1] = updatedLine;

    // If we have a new recurring task, insert it after the completed one
    if (newTaskLine) {
      lines.splice(line, 0, newTaskLine); // Insert at position line (after line-1)
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

    // Note: markdown_tasks cache was removed - file is the source of truth
    debug(`[TASK] Successfully updated task at line ${line}`);
    res.json({ success: true, updatedLine });
  } catch (error) {
    console.error('Error updating task:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Failed to update task', details: error.message });
  }
});

app.post('/save/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).send('Access denied');
    }
    
    // Check if file exists and is a markdown file
    const stats = await fs.stat(fullPath);
    if (!stats.isFile() || !fullPath.endsWith('.md')) {
      return res.status(400).send('Can only save markdown files');
    }
    
    // Write the content
    const { content } = req.body;
    await fs.writeFile(fullPath, content, 'utf-8');
    
    console.log(`File saved: ${fullPath}`);
    res.json({ success: true, message: 'File saved successfully' });
  } catch (error) {
    console.error('Error saving file:', error);
    res.status(500).json({ success: false, message: 'Failed to save file' });
  }
});

// Start time tracking timer
app.post('/api/track/start', authMiddleware, express.json(), async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || description.trim() === '') {
      return res.status(400).json({ success: false, message: 'Description required' });
    }

    const { execSync } = await import('child_process');
    execSync(`bin/track start "${description.replace(/"/g, '\\"')}"`, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe'
    });
    res.json({ success: true, message: 'Timer started' });
  } catch (error) {
    console.error('Error starting timer:', error);
    res.status(500).json({ success: false, message: 'Failed to start timer' });
  }
});

// Stop time tracking timer
app.post('/api/track/stop', authMiddleware, async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    execSync('bin/track stop', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe'
    });
    res.json({ success: true, message: 'Timer stopped' });
  } catch (error) {
    console.error('Error stopping timer:', error);
    res.status(500).json({ success: false, message: 'Failed to stop timer' });
  }
});

// Task detail page - uses tasks table (from plugins)
app.get('/task/:taskId', authMiddleware, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const db = getReadOnlyDatabase();

    // Get task from tasks table
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);

    if (!task) {
      return res.status(404).send('Task not found');
    }

    const metadata = task.metadata ? JSON.parse(task.metadata) : {};
    const priorityEmoji = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' }[task.priority] || '';

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Task: ${task.title.substring(0, 50)}...</title>
        ${pageStyle}
      </head>
      <body>
        ${getNavbar('Task Details', 'fa-tasks', { showSearch: false })}

        <div class="container mt-4">
          <div class="row justify-content-center">
            <div class="col-md-10 col-lg-8">
              <div class="card shadow-sm">
                <div class="card-header bg-white">
                  <h4 class="mb-0">
                    <i class="fas fa-check-circle me-2"></i>Task Details
                  </h4>
                </div>
                <div class="card-body">
                  <!-- Task Text -->
                  <div class="mb-4">
                    <h5 class="text-muted mb-2">Task</h5>
                    <p class="fs-5">${priorityEmoji} ${task.title}</p>
                  </div>

                  <!-- Status -->
                  <div class="mb-4">
                    <h6 class="text-muted mb-2">Status</h6>
                    <span class="badge ${task.status === 'completed' ? 'bg-success' : 'bg-primary'}">${task.status}</span>
                    ${task.priority ? `<span class="badge bg-secondary ms-2">${task.priority}</span>` : ''}
                  </div>

                  ${task.due_date ? `
                  <div class="mb-4">
                    <h6 class="text-muted mb-2">Due Date</h6>
                    <div><i class="fas fa-calendar me-2"></i>${task.due_date}</div>
                  </div>
                  ` : ''}

                  ${task.description ? `
                  <div class="mb-4">
                    <h6 class="text-muted mb-2">Description</h6>
                    <p>${task.description}</p>
                  </div>
                  ` : ''}

                  <!-- Source -->
                  <div class="mb-4">
                    <h6 class="text-muted mb-2">Source</h6>
                    <div><i class="fas fa-plug me-2"></i>${task.source}</div>
                  </div>

                  <!-- Actions -->
                  <div class="d-flex gap-2 flex-wrap">
                    <button class="btn btn-success" onclick="startTimer()">
                      <i class="fas fa-play me-2"></i>Start Timer
                    </button>
                    <button class="btn btn-outline-secondary" onclick="window.history.back()">
                      <i class="fas fa-arrow-left me-2"></i>Back
                    </button>
                  </div>
                </div>
              </div>

              <!-- Task Metadata -->
              <div class="card mt-3 shadow-sm">
                <div class="card-body">
                  <small class="text-muted">
                    <div class="mb-2"><strong>Task ID:</strong> ${task.id}</div>
                    <div class="mb-2"><strong>Created:</strong> ${task.created_at ? new Date(task.created_at).toLocaleString() : 'N/A'}</div>
                    <div class="mb-2"><strong>Updated:</strong> ${task.updated_at ? new Date(task.updated_at).toLocaleString() : 'N/A'}</div>
                    ${task.completed_at ? `<div class="mb-2"><strong>Completed:</strong> ${new Date(task.completed_at).toLocaleString()}</div>` : ''}
                  </small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <script>
          function startTimer() {
            const taskText = ${JSON.stringify(task.title)};
            fetch('/api/track/start', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({description: taskText})
            })
            .then(response => response.json())
            .then(data => {
              if (data.success) {
                alert('Timer started: ' + taskText);
                window.location.href = '/';
              } else {
                alert('Failed to start timer: ' + data.message);
              }
            })
            .catch(error => {
              alert('Error starting timer: ' + error.message);
            });
          }
        </script>

        ${pageScripts}
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('Error loading task:', error);
    res.status(500).send('Error loading task');
  }
});

// OLD Task detail/edit page route - DISABLED (database removed, using Obsidian Tasks in markdown)
/*
app.get('/task/:taskId', authMiddleware, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const task = taskManager.getTask(taskId);
    
    if (!task) {
      return res.status(404).send('Task not found');
    }
    
    // Get all projects and topics for dropdowns
    const projects = taskManager.db.prepare('SELECT id, name FROM projects ORDER BY name').all();
    const topics = taskManager.db.prepare('SELECT id, name FROM topics ORDER BY name').all();
    
    // Build the task editing UI
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Edit Task: ${task.title}</title>
        ${pageStyle}
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
      </head>
      <body>
        ${getNavbar('Task Editor', 'fa-tasks', { showSearch: false })}

        <div class="container mt-4">
          <div class="task-form">
            <div class="card shadow-sm">
              <div class="card-header bg-white">
                <h4 class="mb-0">
                  <i class="fas fa-edit me-2"></i>Edit Task
                </h4>
              </div>
              <div class="card-body">
                <form id="taskForm">
                  <!-- Title -->
                  <div class="mb-3">
                    <label for="title" class="form-label">Title</label>
                    <input type="text" class="form-control" id="title" name="title" 
                           value="${task.title.replace(/"/g, '&quot;')}" required>
                  </div>
                  
                  <!-- Description -->
                  <div class="mb-3">
                    <label for="description" class="form-label">Description</label>
                    <input type="text" class="form-control" id="description" name="description" 
                           value="${(task.description || '').replace(/"/g, '&quot;')}">
                  </div>
                  
                  <!-- Content -->
                  <div class="mb-3">
                    <label for="content" class="form-label">Content</label>
                    <textarea class="form-control" id="content" name="content" rows="5">${task.content || ''}</textarea>
                  </div>
                  
                  <!-- Due Date -->
                  <div class="mb-3">
                    <label for="do_date" class="form-label">Due Date</label>
                    <input type="text" class="form-control" id="do_date" name="do_date" 
                           value="${task.do_date || ''}" placeholder="Click to select date">
                  </div>
                  
                  <!-- Status -->
                  <div class="mb-3">
                    <label for="status" class="form-label">Status</label>
                    <select class="form-select" id="status" name="status">
                      <option value="🗂️ To File" ${task.status === '🗂️ To File' ? 'selected' : ''}>🗂️ To File</option>
                      <option value="1️⃣  1st Priority" ${task.status === '1️⃣  1st Priority' ? 'selected' : ''}>1️⃣ 1st Priority</option>
                      <option value="2️⃣  2nd Priority" ${task.status === '2️⃣  2nd Priority' ? 'selected' : ''}>2️⃣ 2nd Priority</option>
                      <option value="3️⃣  3rd Priority" ${task.status === '3️⃣  3rd Priority' ? 'selected' : ''}>3️⃣ 3rd Priority</option>
                      <option value="🤔 Waiting" ${task.status === '🤔 Waiting' ? 'selected' : ''}>🤔 Waiting</option>
                      <option value="⏸️  Paused" ${task.status === '⏸️  Paused' ? 'selected' : ''}>⏸️ Paused</option>
                      <option value="✅ Done" ${task.status === '✅ Done' ? 'selected' : ''}>✅ Done</option>
                    </select>
                  </div>
                  
                  <!-- Stage -->
                  <div class="mb-3">
                    <label for="stage" class="form-label">Stage</label>
                    <select class="form-select" id="stage" name="stage">
                      <option value="">No Stage</option>
                      <option value="Front Stage" ${task.stage === 'Front Stage' ? 'selected' : ''}>Front Stage</option>
                      <option value="Back Stage" ${task.stage === 'Back Stage' ? 'selected' : ''}>Back Stage</option>
                      <option value="Off Stage" ${task.stage === 'Off Stage' ? 'selected' : ''}>Off Stage</option>
                    </select>
                  </div>
                  
                  <!-- Project -->
                  <div class="mb-3">
                    <label for="project_id" class="form-label">Project</label>
                    <select class="form-select" id="project_id" name="project_id">
                      <option value="">No Project</option>
                      ${projects.map(p => `
                        <option value="${p.id}" ${task.project_id === p.id ? 'selected' : ''}>${p.name}</option>
                      `).join('')}
                    </select>
                  </div>
                  
                  <!-- Topics -->
                  <div class="mb-3">
                    <label for="topics" class="form-label">Topics</label>
                    <select class="form-select" id="topics" name="topics" multiple>
                      ${topics.map(t => `
                        <option value="${t.name}" ${task.topics && task.topics.includes(t.name) ? 'selected' : ''}>${t.name}</option>
                      `).join('')}
                    </select>
                    <small class="text-muted">Hold Ctrl/Cmd to select multiple</small>
                  </div>
                  
                  <!-- Repeat Interval -->
                  <div class="mb-3">
                    <label for="repeat_interval" class="form-label">Repeat Interval (days)</label>
                    <input type="number" class="form-control" id="repeat_interval" name="repeat_interval" 
                           value="${task.repeat_interval || ''}" min="0" placeholder="Leave empty for no repeat">
                  </div>
                  
                  <!-- Buttons -->
                  <div class="d-flex justify-content-between">
                    <button type="submit" class="btn btn-primary">
                      <i class="fas fa-save me-2"></i>Save Changes
                    </button>
                    <button type="button" class="btn btn-secondary" onclick="window.history.back()">
                      <i class="fas fa-times me-2"></i>Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
            
            <!-- Task Info -->
            <div class="card mt-3 shadow-sm">
              <div class="card-body">
                <small class="text-muted">
                  <div>Task ID: ${task.id}</div>
                  <div>Created: ${new Date(task.created_at).toLocaleString()}</div>
                  <div>Updated: ${new Date(task.updated_at).toLocaleString()}</div>
                  ${task.completed_at ? `<div>Completed: ${new Date(task.completed_at).toLocaleString()}</div>` : ''}
                </small>
              </div>
            </div>
          </div>
        </div>

        <!-- Scripts -->
        <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
        ${pageScripts}
        <script>
          // Initialize date picker
          flatpickr("#do_date", {
            dateFormat: "Y-m-d",
            allowInput: true
          });
          
          // Handle form submission
          document.getElementById('taskForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const data = {};
            
            // Process form data
            for (let [key, value] of formData.entries()) {
              if (key === 'topics') {
                // Handle multiple topics
                if (!data.topics) data.topics = [];
                data.topics.push(value);
              } else {
                data[key] = value || null;
              }
            }
            
            // Handle empty values
            if (data.stage === '') data.stage = null;
            if (data.project_id === '') data.project_id = null;
            if (data.repeat_interval === '') data.repeat_interval = null;
            
            try {
              const response = await fetch('/task/${taskId}/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              
              if (response.ok) {
                // Show success message
                const alert = document.createElement('div');
                alert.className = 'alert alert-success position-fixed top-0 start-50 translate-middle-x mt-3';
                alert.style.zIndex = '9999';
                alert.innerHTML = '<i class="fas fa-check-circle me-2"></i>Task updated successfully!';
                document.body.appendChild(alert);
                
                setTimeout(() => {
                  alert.remove();
                  window.history.back();
                }, 1500);
              } else {
                throw new Error('Failed to update task');
              }
            } catch (error) {
              alert('Error updating task: ' + error.message);
            }
          });
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Error loading task:', error);
    res.status(500).send('Internal server error');
  }
});

// Task update route
app.post('/task/:taskId/update', authMiddleware, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const updates = req.body;

    // Update the task
    taskManager.updateTask(taskId, updates);

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});
*/

// Main route handler for root
app.get('/', authMiddleware, async (req, res) => {
  try {
    const urlPath = ''; // Root path
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Render directory listing for root
    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
      const html = await renderDirectory(fullPath, urlPath);
      res.send(html);
    } else {
      res.status(404).send('Not found');
    }
  } catch (error) {
    console.error('Error serving root:', error);
    res.status(500).send('Internal server error');
  }
});

// Main route handler for all other paths
app.get('/*path', authMiddleware, async (req, res) => {
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
    let fullPath = path.join(VAULT_PATH, urlPath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).send('Access denied');
    }

    // Obsidian behavior: if path has no extension, try as-is first, then try with .md
    let stats;
    try {
      stats = await fs.stat(fullPath);
    } catch (error) {
      if (error.code === 'ENOENT' && !path.extname(urlPath)) {
        // No extension and file not found - try adding .md
        const mdPath = fullPath + '.md';
        if (mdPath.startsWith(VAULT_PATH)) {
          try {
            stats = await fs.stat(mdPath);
            fullPath = mdPath;
          } catch {
            // Both attempts failed, throw original error
            throw error;
          }
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    if (stats.isDirectory()) {
      const html = await renderDirectory(fullPath, urlPath);
      res.send(html);
    } else if (stats.isFile()) {
      if (fullPath.endsWith('.md')) {
        const html = await renderMarkdown(fullPath, urlPath);
        res.send(html);
      } else {
        // Serve raw files
        res.sendFile(fullPath);
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).send('File not found');
    } else {
      console.error(error);
      res.status(500).send('Server error');
    }
  }
});

// Start server with extended timeout
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Web server running on http://localhost:${PORT}`);
  console.log(`Username: ${process.env.WEB_USER || 'admin'}`);
  console.log(`Password: ${process.env.WEB_PASSWORD || '(set WEB_PASSWORD in .env)'}`);
});

// Set server timeout to 5 minutes to match AI processing time
server.timeout = 300000; // 5 minutes
server.keepAliveTimeout = 310000; // Slightly longer than timeout
server.headersTimeout = 320000; // Even longer to ensure cleanup
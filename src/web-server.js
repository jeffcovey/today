#!/usr/bin/env node

import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import path from 'path';
import crypto from "crypto";
import fs from 'fs/promises';
import { marked } from 'marked';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3000;
app.set("trust proxy", 1);
const VAULT_PATH = path.join(__dirname, '..', 'vault');

// Cache for rendered Markdown
const renderCache = new Map();
const fileStatsCache = new Map();
const CACHE_MAX_SIZE = 100; // Maximum number of cached files
const CACHE_TTL = 60 * 60 * 1000; // 1 hour TTL for cache entries

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
const validPassword = process.env.WEB_PASSWORD || "changeme";

function sessionAuth(req, res, next) {
  if (req.path === "/auth/login" || req.path === "/auth/logout") return next();
  if (req.session && req.session.authenticated) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect("/auth/login");
}

app.get("/auth/login", (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect("/");
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - Today Vault</title>
      <style>
        body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
        form { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        input { display: block; width: 200px; margin: 0.5rem 0; padding: 0.5rem; border: 1px solid #ddd; border-radius: 4px; }
        button { width: 100%; padding: 0.5rem; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0056b3; }
        h2 { margin: 0 0 1rem 0; color: #333; }
      </style>
    </head>
    <body>
      <form method="POST">
        <h2>Today Vault</h2>
        <input name="username" placeholder="Username" required autofocus>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/auth/login", express.urlencoded({extended:true}), (req,res) => {
  if (req.body.username === validUser && req.body.password === validPassword) {
    req.session.authenticated = true;
    req.session.save(() => res.redirect(req.session.returnTo || "/"));
  } else res.redirect("/auth/login");
});

app.get("/auth/logout", (req,res) => req.session.destroy(() => res.redirect("/auth/login")));

const authMiddleware = sessionAuth;
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// MDBootstrap and custom styles
const pageStyle = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- Font Awesome -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet"/>
<!-- Google Fonts -->
<link href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap" rel="stylesheet"/>
<!-- MDB -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.min.css" rel="stylesheet"/>
<style>
  /* Custom styles to complement MDBootstrap */
  
  /* Styles for collapse components that replace details elements */
  .collapse-header {
    transition: all 0.3s ease;
  }
  body {
    background-color: #f5f5f5;
    min-height: 100vh;
  }
  
  .markdown-content {
    background: white;
    padding: 2rem;
    border-radius: 0.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  
  .markdown-content h1 {
    color: #1266f1;
    font-weight: 300;
    border-bottom: 2px solid #e0e0e0;
    padding-bottom: 0.5rem;
    margin-bottom: 1.5rem;
  }
  
  .markdown-content h2 {
    color: #424242;
    font-weight: 400;
    margin-top: 2rem;
    margin-bottom: 1rem;
  }
  
  .markdown-content h3 {
    color: #616161;
    font-weight: 500;
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
  }
  
  .markdown-content pre {
    background: #263238;
    color: #aed581;
    padding: 1rem;
    border-radius: 0.375rem;
    overflow-x: auto;
    margin: 1rem 0;
  }
  
  .markdown-content code {
    background: rgba(18, 102, 241, 0.1);
    color: #1266f1;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
  }
  
  .markdown-content pre code {
    background: transparent;
    color: #aed581;
    padding: 0;
  }
  
  .markdown-content blockquote {
    border-left: 4px solid #1266f1;
    padding-left: 1rem;
    margin: 1rem 0;
    color: #757575;
    font-style: italic;
  }
  
  .markdown-content table {
    width: 100%;
    margin: 1rem 0;
  }
  
  .markdown-content ul, .markdown-content ol {
    margin: 1rem 0;
    padding-left: 2rem;
  }
  
  .markdown-content li {
    margin: 0.5rem 0;
    line-height: 1.7;
  }
  
  /* Mobile responsiveness */
  @media (max-width: 768px) {
    .markdown-content {
      padding: 1rem;
    }
    
    .container-fluid {
      padding: 0.5rem;
    }
  }
  
  /* Chat interface styles */
  .chat-container {
    height: calc(100vh - 250px);
    max-height: 600px;
    display: flex;
    flex-direction: column;
  }
  
  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    background: #f8f9fa;
  }
  
  .chat-bubble {
    max-width: 70%;
    margin-bottom: 0.5rem;
    word-wrap: break-word;
    padding: 0.35rem 0.5rem !important;
    border-radius: 1rem !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    border: none !important;
  }
  
  .chat-bubble.user {
    margin-left: auto;
    background: #007bff !important;
    color: white !important;
  }
  
  /* Override any nested card styles */
  /* Override ANY nested elements that might have backgrounds */
  .chat-bubble .card,
  .chat-bubble .card-body,
  .chat-bubble div,
  .chat-bubble p,
  .chat-bubble blockquote,
  .chat-bubble pre,
  .chat-bubble code {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    box-shadow: none !important;
  }
  
  /* Ensure bubble content inherits color */
  .chat-bubble.user .bubble-content,
  .chat-bubble.user .markdown-content,
  .chat-bubble.user .markdown-content * {
    color: inherit !important;
  }
  
  .chat-bubble.ai .bubble-content,
  .chat-bubble.ai .markdown-content,
  .chat-bubble.ai .markdown-content * {
    color: inherit !important;
  }
  
  /* Special handling for code blocks to maintain readability */
  .chat-bubble pre code {
    background: rgba(0,0,0,0.1) !important;
    padding: 0.5rem !important;
    border-radius: 0.25rem !important;
  }
  
  .chat-bubble.user pre code {
    background: rgba(255,255,255,0.2) !important;
    color: white !important;
  }
  
  /* AI assistant bubble styling */
  .chat-bubble.assistant,
  .chat-bubble.ai {
    background: #e9ecef !important;
    color: #212529 !important;
  }
  
  /* Typing indicator styling */
  .chat-bubble.typing-indicator {
    background: #e9ecef !important;
  }
  
  .chat-bubble.typing-indicator .spinner-border {
    width: 1rem;
    height: 1rem;
    border-width: 0.15em;
  }
  
  .bubble-content {
    /* Content styling for the bubble */
  }
  
  /* Remove default margins from markdown elements inside bubbles */
  .chat-bubble .markdown-content p:first-child,
  .chat-bubble .markdown-content ul:first-child,
  .chat-bubble .markdown-content ol:first-child,
  .chat-bubble .markdown-content blockquote:first-child,
  .chat-bubble .markdown-content pre:first-child {
    margin-top: 0 !important;
  }
  
  .chat-bubble .markdown-content p:last-child,
  .chat-bubble .markdown-content ul:last-child,
  .chat-bubble .markdown-content ol:last-child,
  .chat-bubble .markdown-content blockquote:last-child,
  .chat-bubble .markdown-content pre:last-child {
    margin-bottom: 0 !important;
  }
  
  /* Compact spacing for all content inside chat bubbles */
  .chat-bubble .markdown-content p {
    margin: 0.2rem 0 !important;
    line-height: 1.3 !important;
  }
  
  .chat-bubble .markdown-content {
    line-height: 1.3 !important;
  }
  
  .chat-bubble .bubble-content {
    padding: 0 !important;
    margin: 0 !important;
  }
  
  /* Markdown content styling in chat */
  .markdown-content {
    font-size: 0.95rem;
    line-height: 1.5;
  }
  
  .markdown-content p {
    margin-bottom: 0.5rem;
  }
  
  .markdown-content p:last-child {
    margin-bottom: 0;
  }
  
  .markdown-content code {
    background: rgba(0, 0, 0, 0.1);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-size: 0.875em;
  }
  
  .chat-bubble.user .markdown-content code {
    background: rgba(255, 255, 255, 0.2);
  }
  
  .markdown-content pre {
    background: #f8f9fa;
    padding: 0.75rem;
    border-radius: 0.375rem;
    overflow-x: auto;
    margin: 0.5rem 0;
  }
  
  .chat-bubble.user .markdown-content pre {
    background: rgba(255, 255, 255, 0.1);
  }
  
  .markdown-content ul, .markdown-content ol {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }
  
  .markdown-content li {
    margin: 0.25rem 0;
  }
  
  .markdown-content blockquote {
    border-left: 3px solid #007bff;
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    color: #6c757d;
  }
  
  .chat-bubble.user .markdown-content blockquote {
    border-left-color: rgba(255, 255, 255, 0.5);
    color: rgba(255, 255, 255, 0.9);
  }
  
  .markdown-content h1, .markdown-content h2, .markdown-content h3, 
  .markdown-content h4, .markdown-content h5, .markdown-content h6 {
    margin-top: 0.75rem;
    margin-bottom: 0.5rem;
    font-weight: 600;
  }
  
  .markdown-content a {
    color: #007bff;
    text-decoration: underline;
  }
  
  .chat-bubble.user .markdown-content a {
    color: #bbdefb;
  }
  
  .chat-input-area {
    border-top: 1px solid #dee2e6;
    padding: 1rem;
    background: white;
  }
  
  .chat-input-area .input-group {
    align-items: stretch;
  }
  
  .chat-input-area textarea {
    resize: none;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  
  .chat-input-area .btn {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    align-self: stretch;
  }
  
  /* Card body with markdown content has scrolling */
  .card-body.markdown-content {
    height: calc(100vh - 200px);
    overflow-y: auto;
    padding: 1.5rem;
  }
  
  @media (max-width: 768px) {
    .chat-container {
      height: 40vh;
    }
    
    .card-body.markdown-content {
      height: auto;
      max-height: 50vh;
    }
  }
</style>
`;

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

// Helper function to extract title from markdown file
// Helper function to get week number
function getWeekNumber(date) {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
  return Math.ceil((days + startOfYear.getDay() + 1) / 7);
}

async function getMarkdownTitle(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    // Look for the first H1 heading
    const titleMatch = content.match(/^# (.+)$/m);
    if (titleMatch) {
      return titleMatch[1].trim();
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
  }
  return null;
}

// Directory listing
async function renderDirectory(dirPath, urlPath) {
  const items = await fs.readdir(dirPath, { withFileTypes: true });
  
  // Sort: directories first, then files
  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  
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
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas fa-folder-open me-2"></i>Vault Browser
          </a>
        </div>
      </nav>

      <!-- Main content with chat -->
      <div class="container-fluid mt-3">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-lg-7 mb-3">
  `;
  
  // Special homepage content
  if (!urlPath) {
    const today = new Date();
    const year = today.getFullYear();
    const quarter = `Q${Math.floor(today.getMonth() / 3) + 1}`;
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const week = getWeekNumber(today);
    const day = String(today.getDate()).padStart(2, '0');
    
    // Check for today's plan
    const todayPlanFile = `${year}-${quarter}-${month}-${day}.md`;
    const todayPlanPath = path.join(dirPath, 'plans', todayPlanFile);
    const todayPlanExists = await fs.access(todayPlanPath).then(() => true).catch(() => false);
    
    // Check for other plan files
    const weekPlanFile = `${year}-${quarter}-${month}-W${week}.md`;
    const monthPlanFile = `${year}-${quarter}-${month}.md`;
    const quarterPlanFile = `${year}-${quarter}.md`;
    const yearPlanFile = `${year}.md`;
    
    const plansDir = path.join(dirPath, 'plans');
    const weekPlanExists = await fs.access(path.join(plansDir, weekPlanFile)).then(() => true).catch(() => false);
    const monthPlanExists = await fs.access(path.join(plansDir, monthPlanFile)).then(() => true).catch(() => false);
    const quarterPlanExists = await fs.access(path.join(plansDir, quarterPlanFile)).then(() => true).catch(() => false);
    const yearPlanExists = await fs.access(path.join(plansDir, yearPlanFile)).then(() => true).catch(() => false);
    
    // Add today's plan if it exists
    if (todayPlanExists) {
      html += `
            <div class="card shadow-sm mb-3">
              <a href="/plans/${todayPlanFile}" class="list-group-item list-group-item-action bg-primary text-white">
                <div class="d-flex align-items-center px-2">
                  <i class="fas fa-calendar-day me-3"></i>
                  <div>
                    <strong>Today's Plan</strong>
                    <br>
                    <small>${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</small>
                  </div>
                </div>
              </a>
            </div>`;
    }
    
    // Add Plans section (collapsed)
    html += `
            <div class="card shadow-sm mb-3">
              <div class="card-header" style="cursor: pointer;" onclick="toggleCollapse('plansSection')">
                <div class="d-flex justify-content-between align-items-center">
                  <span><i class="fas fa-calendar-alt me-2"></i>Plans</span>
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
                  <span><i class="fas fa-history me-2"></i>Recent Pages</span>
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
  
  // Then add files
  for (const item of items) {
    if (!item.isDirectory()) {
      const itemPath = urlPath ? `${urlPath}/${item.name}` : item.name;
      const fullFilePath = path.join(dirPath, item.name);
      const icon = item.name.endsWith('.md') ? 'fa-file-alt text-info' : 'fa-file text-secondary';
      
      // For markdown files, try to get the title from the first H1
      let displayContent;
      if (item.name.endsWith('.md')) {
        const title = await getMarkdownTitle(fullFilePath);
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
        <a href="/${itemPath}" class="list-group-item list-group-item-action">
          ${displayContent}
        </a>`;
    }
  }
  
  html += `
          </div>
        </div>
      </div>

    <!-- Chat column -->
    <div class="col-12 col-lg-5 mb-3">
      <div class="card shadow-sm">
        <div class="card-header bg-primary text-white">
          <i class="fas fa-robot me-2"></i>AI Assistant
        </div>
        <div class="chat-container">
          <div class="chat-messages" id="chatMessages">
            <div class="text-center text-muted p-3">
              <small>Ask questions about this directory and its contents</small>
            </div>
          </div>
          <div class="chat-input-area">
            <div class="input-group">
              <textarea 
                class="form-control" 
                id="chatInput" 
                placeholder="Type your message or /clear to reset..."
                rows="4"
                onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}">
              </textarea>
              <button class="btn btn-primary" onclick="sendMessage()">
                <i class="fas fa-paper-plane"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

      <!-- Marked.js for markdown rendering -->
      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      
      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
      
      <script>
        // Store directory information for AI context
        const directoryPath = '${urlPath || '/'}';
        const directoryContents = ${JSON.stringify(items.map(item => ({
          name: item.name,
          type: item.isDirectory() ? 'directory' : 'file'
        })))};
        
        // Chat functionality
        const CHAT_VERSION = 4;
        const storedVersion = localStorage.getItem('chatVersion');
        if (storedVersion !== String(CHAT_VERSION)) {
          Object.keys(localStorage).forEach(key => {
            if (key.startsWith('chatHistory_') || key === 'inputHistory') {
              localStorage.removeItem(key);
            }
          });
          localStorage.setItem('chatVersion', String(CHAT_VERSION));
          window.location.reload();
        }
        
        let chatHistory = JSON.parse(localStorage.getItem('chatHistory_dir_${urlPath || 'root'}') || '[]');
        let inputHistory = JSON.parse(localStorage.getItem('inputHistory') || '[]');
        let historyIndex = -1;
        
        // Load existing chat messages
        function loadChatHistory() {
          const chatMessages = document.getElementById('chatMessages');
          if (chatHistory.length > 0) {
            chatMessages.innerHTML = '';
            chatHistory.forEach(msg => {
              addChatBubble(msg.content, msg.role, false);
            });
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
          
          // Render markdown using marked
          const renderedContent = marked.parse(message);
          
          let bubbleHtml = \`
            <div class="bubble-content">
              <small class="d-block" style="opacity: 0.6; margin: 0 0 0.05rem 0; font-size: 0.65rem; line-height: 1;">
                \${role === 'user' ? 'You' : 'AI'} · \${timestamp}
              </small>
              <div class="markdown-content" style="margin: 0; padding: 0;">\${renderedContent}</div>
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
            localStorage.setItem('chatHistory_dir_${urlPath || 'root'}', JSON.stringify(chatHistory));
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
            localStorage.removeItem('chatHistory_dir_${urlPath || 'root'}');
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
              <small class="d-block" style="opacity: 0.6; margin: 0 0 0.05rem 0; font-size: 0.65rem; line-height: 1;">AI · Thinking...</small>
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
        
        // Helper function for time ago
        function getTimeAgo(date) {
          const seconds = Math.floor((new Date() - date) / 1000);
          
          let interval = Math.floor(seconds / 31536000);
          if (interval > 1) return interval + ' years ago';
          if (interval === 1) return '1 year ago';
          
          interval = Math.floor(seconds / 2592000);
          if (interval > 1) return interval + ' months ago';
          if (interval === 1) return '1 month ago';
          
          interval = Math.floor(seconds / 86400);
          if (interval > 1) return interval + ' days ago';
          if (interval === 1) return '1 day ago';
          
          interval = Math.floor(seconds / 3600);
          if (interval > 1) return interval + ' hours ago';
          if (interval === 1) return '1 hour ago';
          
          interval = Math.floor(seconds / 60);
          if (interval > 1) return interval + ' minutes ago';
          if (interval === 1) return '1 minute ago';
          
          return 'just now';
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
      <style>
        .editor-container {
          height: calc(100vh - 250px);
          min-height: 400px;
        }
        #editor {
          width: 100%;
          height: 100%;
          font-family: 'Roboto Mono', monospace;
          font-size: 14px;
          border: 1px solid #dee2e6;
          border-radius: 0.375rem;
          padding: 1rem;
          resize: none;
        }
        .editor-toolbar {
          background: #f8f9fa;
          padding: 1rem;
          border-radius: 0.375rem 0.375rem 0 0;
          border: 1px solid #dee2e6;
          border-bottom: none;
        }
      </style>
    </head>
    <body>
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas fa-edit me-2"></i>Editing: ${fileName}
          </a>
          <div class="ms-auto">
            <button onclick="saveFile()" class="btn btn-success btn-sm me-2">
              <i class="fas fa-save me-1"></i>Save
            </button>
            <a href="/${urlPath}" class="btn btn-light btn-sm">
              <i class="fas fa-times me-1"></i>Cancel
            </a>
          </div>
        </div>
      </nav>

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
                <span id="save-status" class="text-muted small"></span>
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

      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
      
      <script>
        function saveFile() {
          const content = document.getElementById('editor').value;
          const saveStatus = document.getElementById('save-status');
          
          saveStatus.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Saving...';
          saveStatus.className = 'text-primary small';
          
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
              saveStatus.className = 'text-success small';
              setTimeout(() => {
                saveStatus.innerHTML = '';
              }, 3000);
            } else {
              throw new Error('Save failed');
            }
          })
          .catch(error => {
            saveStatus.innerHTML = '<i class="fas fa-exclamation-triangle me-1"></i>Save failed!';
            saveStatus.className = 'text-danger small';
          });
        }
        
        // Auto-save on Ctrl+S / Cmd+S
        document.getElementById('editor').addEventListener('keydown', function(e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
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
      console.log(`[CACHE HIT] ${urlPath} (hits: ${cached.hits})`);
      return cached.html;
    }
    
    // Render and cache the result
    console.log(`[CACHE MISS] ${urlPath} - rendering...`);
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

// Uncached Markdown rendering (original implementation)
async function renderMarkdownUncached(filePath, urlPath) {
  console.log('[DEBUG] renderMarkdown called for:', urlPath);
  const content = await fs.readFile(filePath, 'utf-8');
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
  
  // Find all checkbox lines in the original content
  const checkboxLines = [];
  lines.forEach((line, index) => {
    if (line.match(/^(\s*)-\s*\[([x\s])\]\s*/i)) {
      checkboxLines.push({
        lineNumber: index,
        isChecked: line.match(/^(\s*)-\s*\[[xX]\]\s*/i) !== null
      });
    }
  });
  
  // Render the markdown normally (without the title if we extracted it)
  let htmlContent = marked(contentToRender);
  
  // Convert emojis to Font Awesome icons
  htmlContent = convertEmojisToIcons(htmlContent);
  
  // Enhance tables with MDBootstrap styling
  htmlContent = htmlContent.replace(/<table>/g, '<table class="table table-hover table-striped">');
  
  // Enhance blockquotes with MDBootstrap styling
  htmlContent = htmlContent.replace(/<blockquote>/g, '<blockquote class="blockquote border-start border-4 border-primary ps-3 my-3">');
  
  // Enhance code blocks with better styling
  htmlContent = htmlContent.replace(/<pre><code class="language-([^"]*)">([\s\S]*?)<\/code><\/pre>/g, 
    '<div class="card bg-dark mb-3"><div class="card-body p-0"><pre class="mb-0"><code class="language-$1 text-light p-3 d-block">$2</code></pre></div></div>');
  
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
  
  // Replace the checkboxes that marked generated with our interactive ones
  let replacementIndex = 0;
  htmlContent = htmlContent.replace(
    /<input\s+(?:checked=""\s+)?(?:disabled=""\s+)?type="checkbox"(?:\s+disabled="")?>/gi,
    (match) => {
      if (replacementIndex < checkboxLines.length) {
        const checkbox = checkboxLines[replacementIndex];
        replacementIndex++;
        return `<input type="checkbox" class="form-check-input me-2" 
          data-line="${checkbox.lineNumber}" 
          ${checkbox.isChecked ? 'checked' : ''} 
          onchange="toggleCheckbox(this, ${checkbox.lineNumber}, event)" 
          onclick="event.stopPropagation();" 
          style="cursor: pointer;">`;
      }
      return match;
    }
  );
  
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
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas fa-file-alt me-2"></i>${fileName}
          </a>
          <div class="ms-auto">
            <a href="/edit/${urlPath}" class="btn btn-light btn-sm">
              <i class="fas fa-edit me-1"></i>Edit
            </a>
          </div>
        </div>
      </nav>

      <!-- Main content with chat -->
      <div class="container-fluid mt-3">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-lg-7 mb-3">
            <div class="card shadow-sm h-100">
              ${pageTitle ? `<div class="card-header bg-white border-bottom">
                <h5 class="mb-0">${pageTitle}</h5>
              </div>` : ''}
              <div class="card-body markdown-content">
                ${htmlContent}
              </div>
            </div>
          </div>
          
          <!-- Chat column -->
          <div class="col-12 col-lg-5 mb-3">
            <div class="card shadow-sm">
              <div class="card-header bg-primary text-white">
                <i class="fas fa-robot me-2"></i>AI Assistant
              </div>
              <div class="chat-container">
                <div class="chat-messages" id="chatMessages">
                  <div class="text-center text-muted p-3">
                    <small>Start a conversation about this document</small>
                  </div>
                </div>
                <div class="chat-input-area">
                  <div class="input-group">
                    <textarea 
                      class="form-control" 
                      id="chatInput" 
                      placeholder="Type your message or /clear to reset..."
                      rows="4"
                      onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}">
                    </textarea>
                    <button class="btn btn-primary" onclick="sendMessage()">
                      <i class="fas fa-paper-plane"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Marked.js for markdown rendering -->
      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      
      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
      
      <script>
        // Chat functionality
        // Version 4: Force clear all old chat to fix structure
        const CHAT_VERSION = 4;
        const storedVersion = localStorage.getItem('chatVersion');
        if (storedVersion !== String(CHAT_VERSION)) {
          // Clear ALL chat-related data
          Object.keys(localStorage).forEach(key => {
            if (key.startsWith('chatHistory_') || key === 'inputHistory') {
              localStorage.removeItem(key);
            }
          });
          localStorage.setItem('chatVersion', String(CHAT_VERSION));
          // Force page refresh to ensure clean start
          window.location.reload();
        }
        
        let chatHistory = JSON.parse(localStorage.getItem('chatHistory_${urlPath}') || '[]');
        let inputHistory = JSON.parse(localStorage.getItem('inputHistory') || '[]');
        let historyIndex = -1;
        
        // Load existing chat messages
        function loadChatHistory() {
          const chatMessages = document.getElementById('chatMessages');
          if (chatHistory.length > 0) {
            chatMessages.innerHTML = '';
            chatHistory.forEach(msg => {
              addChatBubble(msg.content, msg.role, false);
            });
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
          
          // Render markdown using marked
          const renderedContent = marked.parse(message);
          
          let bubbleHtml = \`
            <div class="bubble-content">
              <small class="d-block" style="opacity: 0.6; margin: 0 0 0.05rem 0; font-size: 0.65rem; line-height: 1;">
                \${role === 'user' ? 'You' : 'AI'} · \${timestamp}
              </small>
              <div class="markdown-content" style="margin: 0; padding: 0;">\${renderedContent}</div>
          \`;
          
          if (replyTime) {
            bubbleHtml += \`<small class="d-block mt-1" style="opacity: 0.4; font-size: 0.55rem; font-style: italic;">Replied in \${replyTime}</small>\`;
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
            localStorage.setItem('chatHistory_${urlPath}', JSON.stringify(chatHistory));
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
            localStorage.removeItem('chatHistory_${urlPath}');
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
          
          // Create initial HTML
          typingIndicator.innerHTML = \`
            <div class="bubble-content">
              <small class="d-block" style="opacity: 0.6; margin: 0 0 0.05rem 0; font-size: 0.65rem; line-height: 1;">AI · Thinking...</small>
              <div class="d-flex align-items-center">
                <div class="spinner-border spinner-border-sm text-secondary me-2" role="status">
                  <span class="visually-hidden">Loading...</span>
                </div>
                <span class="text-muted" id="ai-timer">0 seconds</span>
              </div>
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
            
            // Create abort controller with 5 minute timeout (matching server)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 300000); // 5 minutes
            
            const response = await fetch(\`/ai-chat/${urlPath}\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: message,
                history: chatHistory,
                documentContent: markdownContent
              }),
              signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (!response.ok) throw new Error('Failed to get AI response');
            
            const data = await response.json();
            
            // Remove typing indicator and clear timer
            clearInterval(timerInterval);
            typingIndicator.remove();
            
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
            
            // Add AI response with time
            addChatBubble(data.response, 'assistant', true, timeStr);
            
            // If file was modified, refresh the content area
            if (data.fileModified) {
              refreshContentArea();
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
              
              // Re-attach checkbox handlers
              currentContent.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                checkbox.onchange = function(e) {
                  toggleCheckbox(this, parseInt(this.dataset.line), e);
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
        
        function toggleCheckbox(checkbox, lineNumber, event) {
          const isChecked = checkbox.checked;
          
          // Prevent the details element from toggling when clicking checkbox
          if (event) {
            event.stopPropagation();
          }
          
          // Disable the checkbox while saving
          checkbox.disabled = true;
          
          fetch(\`/toggle-checkbox/${urlPath}\`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
              lineNumber: lineNumber,
              checked: isChecked 
            })
          })
          .then(response => {
            if (!response.ok) {
              throw new Error('Failed to toggle checkbox');
            }
            return response.json();
          })
          .then(data => {
            // Re-enable the checkbox
            checkbox.disabled = false;
            
            // Add a brief visual feedback
            // Only modify the immediate parent if it's not a details element
            const parent = checkbox.parentElement;
            if (parent && !parent.closest('details')) {
              const originalColor = parent.style.color;
              parent.style.color = '#4caf50';
              setTimeout(() => {
                parent.style.color = originalColor;
              }, 500);
            }
          })
          .catch(error => {
            console.error('Error toggling checkbox:', error);
            // Revert the checkbox state on error
            checkbox.checked = !isChecked;
            checkbox.disabled = false;
            alert('Failed to save checkbox state');
          });
        }
        
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
  
  console.log('[DEBUG] HTML includes chatMessages:', html.includes('chatMessages'));
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
app.post('/ai-edit/*', async (req, res) => {
  try {
    const urlPath = req.path.slice(9); // Remove '/ai-edit/' prefix
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

// AI Chat route handler  
app.post('/ai-chat/*', async (req, res) => {
  // Set timeout for this specific request to 5 minutes
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  
  try {
    const urlPath = req.path.slice(9); // Remove '/ai-chat/' prefix
    const { message, history, documentContent } = req.body;
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Get initial file modification time
    let initialMtime = null;
    try {
      const stats = await fs.stat(fullPath);
      initialMtime = stats.mtimeMs;
    } catch (e) {
      // File might not exist or be accessible
    }
    
    // Build conversation for Claude
    let conversation = "You are an AI assistant helping with a markdown document. ";
    conversation += `The user is viewing: ${urlPath}\n`;
    conversation += `File location: vault/${urlPath}\n\n`;
    conversation += "IMPORTANT: When the user asks you to edit or update this document:\n";
    conversation += "- You have the ability to directly edit the file\n";
    conversation += "- Make the requested changes to the content\n";
    conversation += "- The interface will automatically refresh to show your changes\n\n";
    conversation += "---CURRENT DOCUMENT CONTENT---\n";
    conversation += documentContent || "(No document content available)";
    conversation += "\n---END DOCUMENT---\n\n";
    
    if (history && history.length > 0) {
      conversation += "Previous conversation:\n";
      history.forEach(msg => {
        conversation += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      conversation += "\n";
    }
    
    conversation += `User: ${message}\n`;
    conversation += "Assistant: ";
    
    // Call Claude using the claude CLI
    const { spawn } = await import('child_process');
    
    try {
      // Debug logging
      console.log('[AI Chat] Starting Claude execution...');
      console.log('[AI Chat] Working directory:', process.cwd());
      console.log('[AI Chat] Conversation length:', conversation.length);
      console.log('[AI Chat] First 200 chars of conversation:', conversation.substring(0, 200));
      
      // Use spawn to properly pipe input to claude --print
      const claude = spawn('claude', ['--print'], {
        cwd: process.cwd(),
        timeout: 300000 // 5 minute timeout for complex requests
      });
      
      let stdout = '';
      let stderr = '';
      
      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      // Write the conversation to stdin
      claude.stdin.write(conversation);
      claude.stdin.end();
      
      // Wait for the process to complete
      await new Promise((resolve, reject) => {
        claude.on('close', (code) => {
          console.log('[AI Chat] Claude process exited with code:', code);
          console.log('[AI Chat] stdout length:', stdout.length);
          console.log('[AI Chat] stderr:', stderr || '(none)');
          
          if (code !== 0) {
            console.error('[AI Chat] Claude failed with code:', code);
            console.error('[AI Chat] stderr:', stderr);
            // Don't reject for timeout (code null) or non-zero codes, handle gracefully
            if (code === null) {
              reject(new Error('Request timed out after 5 minutes'));
            } else {
              reject(new Error(`Claude exited with code ${code}: ${stderr || 'Unknown error'}`));
            }
          } else {
            resolve();
          }
        });
        
        claude.on('error', (err) => {
          console.error('[AI Chat] Failed to start Claude:', err);
          reject(err);
        });
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
        response: stdout.trim(),
        fileModified: fileModified
      });
    } catch (error) {
      console.error('[AI Chat] Error calling Claude:', error);
      
      let errorResponse = "I'm having trouble processing your request.";
      if (error.message && error.message.includes('timed out')) {
        errorResponse = "The AI request took too long (over 5 minutes). Complex questions may need to be broken into smaller parts. Please try again.";
      } else if (error.message && error.message.includes('code 124')) {
        errorResponse = "The request timed out. Please try a shorter or simpler question.";
      } else if (error.message && error.message.includes('code')) {
        errorResponse = "The AI service encountered an error. Please try again in a moment.";
      }
      
      res.json({ 
        response: errorResponse
      });
    }
    
  } catch (error) {
    console.error('Error in AI chat:', error);
    res.status(500).json({ 
      success: false, 
      response: 'An error occurred while processing your request.' 
    });
  }
});

// AI Chat route handler for directories
app.post('/ai-chat-directory/*', async (req, res) => {
  // Set timeout for this specific request to 5 minutes
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  
  try {
    const urlPath = req.path.slice(19); // Remove '/ai-chat-directory/' prefix
    const { message, history, directoryContext } = req.body;
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Build conversation for Claude
    let conversation = "You are an AI assistant helping with a directory in a markdown vault. ";
    conversation += `The user is viewing directory: ${urlPath || '/'}\n`;
    conversation += `Full path: vault/${urlPath || '/'}\n\n`;
    conversation += "Directory contents:\n";
    conversation += directoryContext || "(No directory content available)";
    conversation += "\n\n";
    conversation += "You can help the user understand what files are in this directory, ";
    conversation += "suggest which files to look at, and answer questions about organizing ";
    conversation += "or navigating the content.\n\n";
    
    if (history && history.length > 0) {
      conversation += "Previous conversation:\n";
      history.forEach(msg => {
        conversation += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      });
      conversation += "\n";
    }
    
    conversation += `User: ${message}\n`;
    conversation += "Assistant: ";
    
    // Call Claude using the claude CLI
    const { spawn } = await import('child_process');
    
    try {
      // Debug logging
      console.log('[AI Directory Chat] Starting Claude execution...');
      console.log('[AI Directory Chat] Directory path:', urlPath || '/');
      
      // Use spawn to properly pipe input to claude --print
      const claude = spawn('claude', ['--print'], {
        cwd: process.cwd(),
        timeout: 300000 // 5 minute timeout for complex requests
      });
      
      let stdout = '';
      let stderr = '';
      
      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      // Write the conversation to stdin
      claude.stdin.write(conversation);
      claude.stdin.end();
      
      // Wait for the process to complete
      await new Promise((resolve, reject) => {
        claude.on('close', (code) => {
          console.log('[AI Directory Chat] Claude process exited with code:', code);
          
          if (code !== 0) {
            console.error('[AI Directory Chat] Claude failed with code:', code);
            console.error('[AI Directory Chat] stderr:', stderr);
            if (code === null) {
              reject(new Error('Request timed out after 5 minutes'));
            } else {
              reject(new Error(`Claude exited with code ${code}: ${stderr || 'Unknown error'}`));
            }
          } else {
            resolve();
          }
        });
        
        claude.on('error', (err) => {
          console.error('[AI Directory Chat] Failed to start Claude:', err);
          reject(err);
        });
      });
      
      res.json({ 
        response: stdout.trim()
      });
    } catch (error) {
      console.error('[AI Directory Chat] Error calling Claude:', error);
      
      let errorResponse = "I'm having trouble processing your request.";
      if (error.message && error.message.includes('timed out')) {
        errorResponse = "The AI request took too long. Please try a shorter or simpler question.";
      } else if (error.message && error.message.includes('code')) {
        errorResponse = "The AI service encountered an error. Please try again in a moment.";
      }
      
      res.json({ 
        response: errorResponse
      });
    }
    
  } catch (error) {
    console.error('Error in AI directory chat:', error);
    res.status(500).json({ 
      success: false, 
      response: 'An error occurred while processing your request.' 
    });
  }
});

// Edit route handler
app.get('/edit/*', async (req, res) => {
  try {
    const urlPath = req.path.slice(6); // Remove '/edit/' prefix
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
app.post('/toggle-checkbox/*', async (req, res) => {
  try {
    const urlPath = req.path.slice(16); // Remove '/toggle-checkbox/' prefix
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
    const { lineNumber, checked } = req.body;
    
    // Split into lines
    const lines = content.split('\n');
    
    // Find and toggle the checkbox on the specified line
    if (lineNumber >= 0 && lineNumber < lines.length) {
      const line = lines[lineNumber];
      
      // Match checkbox patterns: - [ ] or - [x] or - [X]
      if (checked) {
        // Check the box
        lines[lineNumber] = line.replace(/^(\s*)-\s*\[\s*\]\s*/, '$1- [x] ');
      } else {
        // Uncheck the box
        lines[lineNumber] = line.replace(/^(\s*)-\s*\[[xX]\]\s*/, '$1- [ ] ');
      }
      
      // Write back to file
      content = lines.join('\n');
      await fs.writeFile(fullPath, content, 'utf-8');
      
      console.log(`Checkbox toggled in: ${fullPath}, line ${lineNumber}`);
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
app.post('/save/*', async (req, res) => {
  try {
    const urlPath = req.path.slice(6); // Remove '/save/' prefix
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

// Main route handler
app.get('*', async (req, res) => {
  try {
    const urlPath = req.path.slice(1); // Remove leading slash
    const fullPath = path.join(VAULT_PATH, urlPath);
    
    // Security: prevent directory traversal
    if (!fullPath.startsWith(VAULT_PATH)) {
      return res.status(403).send('Access denied');
    }
    
    const stats = await fs.stat(fullPath);
    
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
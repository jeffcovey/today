#!/usr/bin/env node

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs/promises';
import { marked } from 'marked';
import basicAuth from 'express-basic-auth';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3000;
const VAULT_PATH = path.join(__dirname, '..', 'vault');

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware - must come before auth
app.use(session({
  secret: process.env.SESSION_SECRET || 'vault-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Basic authentication with session support
const users = {};
users[process.env.WEB_USER || 'admin'] = process.env.WEB_PASSWORD || 'changeme';

// Custom auth middleware that checks session first
const authMiddleware = basicAuth({
  users,
  challenge: true,
  realm: 'Today Vault',
  authorizeAsync: true,
  authorizer: (username, password, callback) => {
    const userMatches = basicAuth.safeCompare(username, process.env.WEB_USER || 'admin');
    const passwordMatches = basicAuth.safeCompare(password, users[username] || '');
    callback(null, userMatches && passwordMatches);
  }
});

app.use((req, res, next) => {
  // If already authenticated in session, skip basic auth
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  // Otherwise use basic auth and save to session on success
  authMiddleware(req, res, (err) => {
    if (!err && req.auth) {
      // Authentication successful, save to session
      req.session.authenticated = true;
      req.session.username = req.auth.user;
    }
    next(err);
  });
});

// Serve static CSS
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// MDBootstrap and custom styles
const pageStyle = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- Font Awesome -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet"/>
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
    height: calc(100vh - 200px);
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

      <!-- Main content -->
      <div class="container mt-4">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <!-- File list -->
        <div class="card shadow-sm">
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
      const icon = item.name.endsWith('.md') ? 'fa-file-alt text-info' : 'fa-file text-secondary';
      html += `
        <a href="/${itemPath}" class="list-group-item list-group-item-action">
          <i class="fas ${icon} me-3"></i>
          ${item.name}
        </a>`;
    }
  }
  
  html += `
          </div>
        </div>
      </div>

      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
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

// Markdown rendering
async function renderMarkdown(filePath, urlPath) {
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
    const summaryText = summaryMatch ? summaryMatch[1].trim() : 'Click to expand';
    const detailsContent = content.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '').trim();
    
    // Check if it should be open by default
    const isOpen = match.includes('open');
    
    return `
      <div class="mb-3">
        <div class="d-flex align-items-center p-2 bg-light rounded" 
             style="cursor: pointer; user-select: none;"
             onclick="const content = this.nextElementSibling; const icon = this.querySelector('i'); 
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
                    <input type="text" 
                      class="form-control" 
                      id="chatInput" 
                      placeholder="Type your message or /clear to reset..."
                      onkeypress="if(event.key==='Enter')sendMessage()">
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
            
            const response = await fetch('/ai-chat/${urlPath}', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: message,
                history: chatHistory,
                documentContent: markdownContent
              })
            });
            
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
            
            // Add error with timing info
            addChatBubble(errorMessage, 'assistant', true, 'Failed after ' + timeStr);
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
      </script>
    </body>
    </html>
  `;
  
  console.log('[DEBUG] HTML includes chatMessages:', html.includes('chatMessages'));
  return html;
}

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

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Web server running on http://localhost:${PORT}`);
  console.log(`Username: ${process.env.WEB_USER || 'admin'}`);
  console.log(`Password: ${process.env.WEB_PASSWORD || '(set WEB_PASSWORD in .env)'}`);
});
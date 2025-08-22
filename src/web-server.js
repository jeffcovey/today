#!/usr/bin/env node

import express from 'express';
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

// Basic authentication
const users = {};
users[process.env.WEB_USER || 'admin'] = process.env.WEB_PASSWORD || 'changeme';

app.use(basicAuth({
  users,
  challenge: true,
  realm: 'Today Vault'
}));

// Serve static CSS
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// Custom CSS for markdown rendering
const pageStyle = `
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    line-height: 1.6;
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem;
    background: #f6f8fa;
  }
  .content {
    background: white;
    padding: 2rem;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  }
  h1 { color: #0969da; border-bottom: 2px solid #d1d9e0; padding-bottom: 0.3rem; }
  h2 { color: #1f2328; margin-top: 2rem; }
  h3 { color: #1f2328; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  pre {
    background: #f6f8fa;
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
  }
  code {
    background: #f6f8fa;
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-size: 85%;
  }
  ul, ol { padding-left: 2rem; }
  li { margin: 0.5rem 0; }
  input[type="checkbox"] { margin-right: 0.5rem; }
  .directory-list {
    list-style: none;
    padding: 0;
  }
  .directory-list li {
    padding: 0.5rem;
    border-bottom: 1px solid #d1d9e0;
  }
  .directory-list li:hover {
    background: #f6f8fa;
  }
  .breadcrumb {
    padding: 1rem 0;
    color: #656d76;
  }
  .breadcrumb a {
    color: #0969da;
    margin: 0 0.25rem;
  }
  .file-icon { margin-right: 0.5rem; }
  .dir { font-weight: bold; }
  .file { color: #1f2328; }
  .nav-header {
    background: #24292f;
    color: white;
    padding: 1rem;
    margin: -2rem -2rem 2rem -2rem;
    border-radius: 8px 8px 0 0;
  }
  .nav-header a { color: white; }
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
  
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Vault: ${urlPath || '/'}</title>
      ${pageStyle}
    </head>
    <body>
      <div class="content">
        <div class="nav-header">
          <h1>📁 Vault Browser</h1>
        </div>
        <div class="breadcrumb">${getBreadcrumb(urlPath)}</div>
        <ul class="directory-list">
  `;
  
  // Add parent directory link if not at root
  if (urlPath) {
    const parentPath = path.dirname(urlPath);
    html += `<li><a href="/${parentPath === '.' ? '' : parentPath}" class="dir">📁 ..</a></li>`;
  }
  
  for (const item of items) {
    const itemPath = urlPath ? `${urlPath}/${item.name}` : item.name;
    if (item.isDirectory()) {
      html += `<li><a href="/${itemPath}" class="dir"><span class="file-icon">📁</span>${item.name}/</a></li>`;
    } else {
      const icon = item.name.endsWith('.md') ? '📄' : '📋';
      html += `<li><a href="/${itemPath}" class="file"><span class="file-icon">${icon}</span>${item.name}</a></li>`;
    }
  }
  
  html += `
        </ul>
      </div>
    </body>
    </html>
  `;
  
  return html;
}

// Markdown rendering
async function renderMarkdown(filePath, urlPath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const htmlContent = marked(content);
  
  const fileName = path.basename(urlPath);
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${fileName}</title>
      ${pageStyle}
    </head>
    <body>
      <div class="content">
        <div class="nav-header">
          <h1>📄 ${fileName}</h1>
        </div>
        <div class="breadcrumb">${getBreadcrumb(urlPath)}</div>
        ${htmlContent}
      </div>
    </body>
    </html>
  `;
}

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
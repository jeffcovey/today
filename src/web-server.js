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

// Middleware for parsing JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  const content = await fs.readFile(filePath, 'utf-8');
  const htmlContent = marked(content);
  
  const fileName = path.basename(urlPath);
  
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
  
  return `
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

      <!-- Main content -->
      <div class="container mt-4">
        <!-- Breadcrumb -->
        <nav aria-label="breadcrumb">
          <ol class="breadcrumb">
            ${breadcrumbHtml}
          </ol>
        </nav>

        <!-- Markdown content -->
        <div class="card shadow-sm">
          <div class="card-body markdown-content">
            ${htmlContent}
          </div>
        </div>
      </div>

      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
    </body>
    </html>
  `;
}

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
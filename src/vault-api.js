#!/usr/bin/env node

// Vault API - Provides read and write access to vault files for Drafts sync
// Combines vault read operations and inbox write operations

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const app = express();
const PORT = process.env.VAULT_API_PORT || 3334;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// API key authentication middleware
// Try to read from environment or generate random key
async function getApiKey() {
  let apiKey = process.env.INBOX_API_KEY;
  if (!apiKey) {
    // Try to read from the key file directly
    try {
      const keyFile = await fs.readFile(path.join(projectRoot, '.inbox-api-key'), 'utf8');
      const match = keyFile.match(/INBOX_API_KEY=(.+)/);
      if (match) {
        apiKey = match[1].trim();
      }
    } catch (error) {
      // If all else fails, generate a random key
      apiKey = crypto.randomBytes(32).toString('hex');
    }
  }
  return apiKey;
}

const API_KEY = await getApiKey();
const INBOX_DIR = path.join(projectRoot, 'vault/notes/inbox');

// Ensure inbox directory exists
await fs.mkdir(INBOX_DIR, { recursive: true }).catch(() => {});

// Log the API key on startup (only in development)
if (process.env.NODE_ENV !== 'production') {
  console.log(`Vault API Key: ${API_KEY}`);
}

const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Valid API key required'
    });
  }
  
  next();
};

// List all vault markdown files
app.get('/vault/list', authenticateApiKey, async (req, res) => {
  try {
    const vaultPath = path.join(projectRoot, 'vault');
    const files = [];
    
    async function scanDir(dir, basePath = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);
        
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          // Recurse into subdirectories
          await scanDir(fullPath, relativePath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Get file stats and calculate SHA
          const stats = await fs.stat(fullPath);
          const content = await fs.readFile(fullPath, 'utf8');
          const sha = crypto.createHash('sha256').update(content).digest('hex');
          
          files.push({
            path: `vault/${relativePath.replace(/\\/g, '/')}`,
            modified: stats.mtime.toISOString(),
            size: stats.size,
            sha: sha
          });
        }
      }
    }
    
    await scanDir(vaultPath);
    
    res.json({
      success: true,
      count: files.length,
      files: files
    });
  } catch (error) {
    console.error('Error listing vault files:', error);
    res.status(500).json({
      error: 'Failed to list vault files',
      message: error.message
    });
  }
});

// Get a specific vault file
app.get('/vault/file/*', authenticateApiKey, async (req, res) => {
  try {
    // Get the file path from the URL
    const requestedPath = req.params[0];
    
    // Security: ensure the path doesn't escape the vault directory
    if (requestedPath.includes('..') || requestedPath.startsWith('/')) {
      return res.status(400).json({
        error: 'Invalid path',
        message: 'Path traversal not allowed'
      });
    }
    
    const filePath = path.join(projectRoot, 'vault', requestedPath);
    
    // Check if file exists and is within vault
    const realPath = await fs.realpath(filePath).catch(() => null);
    const vaultPath = await fs.realpath(path.join(projectRoot, 'vault'));
    
    if (!realPath || !realPath.startsWith(vaultPath)) {
      return res.status(404).json({
        error: 'File not found',
        path: `vault/${requestedPath}`
      });
    }
    
    // Read the file
    const content = await fs.readFile(filePath, 'utf8');
    const stats = await fs.stat(filePath);
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    
    // Encode content as Base64 to avoid JSON parsing issues with special characters
    const contentBase64 = Buffer.from(content, 'utf8').toString('base64');
    
    res.json({
      success: true,
      path: `vault/${requestedPath}`,
      content: contentBase64,
      contentEncoding: 'base64',
      modified: stats.mtime.toISOString(),
      size: stats.size,
      sha: sha
    });
  } catch (error) {
    console.error('Error reading vault file:', error);
    
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'File not found',
        path: `vault/${req.params[0]}`
      });
    }
    
    res.status(500).json({
      error: 'Failed to read file',
      message: error.message
    });
  }
});

// Get multiple files at once (batch operation)
app.post('/vault/batch', authenticateApiKey, async (req, res) => {
  try {
    const { paths } = req.body;
    
    if (!Array.isArray(paths)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'paths must be an array'
      });
    }
    
    const results = {};
    const errors = [];
    
    for (const requestedPath of paths) {
      try {
        // Security checks
        if (requestedPath.includes('..') || requestedPath.startsWith('/')) {
          errors.push({
            path: requestedPath,
            error: 'Invalid path'
          });
          continue;
        }
        
        // Remove 'vault/' prefix if present
        const cleanPath = requestedPath.replace(/^vault\//, '');
        const filePath = path.join(projectRoot, 'vault', cleanPath);
        
        const content = await fs.readFile(filePath, 'utf8');
        const stats = await fs.stat(filePath);
        const sha = crypto.createHash('sha256').update(content).digest('hex');
        
        // Encode content as Base64 for safe JSON transport
        const contentBase64 = Buffer.from(content, 'utf8').toString('base64');
        
        results[requestedPath] = {
          content: contentBase64,
          contentEncoding: 'base64',
          modified: stats.mtime.toISOString(),
          size: stats.size,
          sha: sha
        };
      } catch (error) {
        errors.push({
          path: requestedPath,
          error: error.code === 'ENOENT' ? 'Not found' : error.message
        });
      }
    }
    
    res.json({
      success: true,
      results: results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error in batch operation:', error);
    res.status(500).json({
      error: 'Batch operation failed',
      message: error.message
    });
  }
});

// ============ INBOX ENDPOINTS ============

// Upload endpoint (inbox functionality)
app.post('/inbox/upload', authenticateApiKey, async (req, res) => {
  try {
    let content, filename;
    
    // Support both JSON and plain text uploads
    if (req.is('application/json')) {
      content = req.body.content;
      filename = req.body.filename;
    } else if (req.is('text/plain')) {
      content = req.body;
      // Generate filename from first line
      const lines = content.split('\n');
      const title = lines[0].replace(/^#\s*/, '').trim() || 'Untitled';
      const date = new Date();
      const dateStr = date.toISOString().split('T')[0];
      const timeStr = date.toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
      const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
      filename = `${dateStr}-${timeStr}-UTC-${titleSlug || 'untitled'}.md`;
    } else {
      return res.status(400).json({ error: 'Content must be JSON or plain text' });
    }
    
    if (!content) {
      return res.status(400).json({ error: 'No content provided' });
    }
    
    if (!filename) {
      return res.status(400).json({ error: 'No filename provided' });
    }
    
    // Sanitize filename
    filename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!filename.endsWith('.md')) {
      filename += '.md';
    }
    
    // Write file
    const filepath = path.join(INBOX_DIR, filename);
    await fs.writeFile(filepath, content, 'utf8');
    
    console.log(`Uploaded to inbox: ${filename}`);
    
    res.json({
      success: true,
      filename,
      path: `vault/notes/inbox/${filename}`,
      size: Buffer.byteLength(content, 'utf8')
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to save file' });
  }
});

// List inbox files
app.get('/inbox/list', authenticateApiKey, async (req, res) => {
  try {
    const files = await fs.readdir(INBOX_DIR);
    const markdownFiles = files.filter(f => f.endsWith('.md'));
    
    const fileInfo = await Promise.all(markdownFiles.map(async (file) => {
      const filepath = path.join(INBOX_DIR, file);
      const stats = await fs.stat(filepath);
      return {
        filename: file,
        size: stats.size,
        modified: stats.mtime
      };
    }));
    
    res.json({
      count: fileInfo.length,
      files: fileInfo
    });
    
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'vault-api',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Vault API server running on http://127.0.0.1:${PORT}`);
  console.log(`API Key: ${API_KEY}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/health`);
  console.log('');
  console.log('Vault endpoints:');
  console.log(`  - List files: http://127.0.0.1:${PORT}/vault/list`);
  console.log(`  - Get file: http://127.0.0.1:${PORT}/vault/file/[path]`);
  console.log('');
  console.log('Inbox endpoints:');
  console.log(`  - Upload: http://127.0.0.1:${PORT}/inbox/upload`);
  console.log(`  - List inbox: http://127.0.0.1:${PORT}/inbox/list`);
  console.log('');
  console.log('To test upload:');
  console.log(`curl -X POST http://localhost:${PORT}/inbox/upload \\`);
  console.log(`  -H "X-API-Key: ${API_KEY}" \\`);
  console.log(`  -H "Content-Type: text/plain" \\`);
  console.log(`  -d "# Test Note\n\nThis is a test"`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
#!/usr/bin/env node

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

// Simple API key authentication (set in environment)
const API_KEY = process.env.INBOX_API_KEY || crypto.randomBytes(32).toString('hex');
const INBOX_DIR = path.join(projectRoot, 'vault/inbox');

// Log the API key on startup (only in development)
if (process.env.NODE_ENV !== 'production') {
  console.log(`Inbox API Key: ${API_KEY}`);
}

// Ensure inbox directory exists
await fs.mkdir(INBOX_DIR, { recursive: true }).catch(() => {});

// Middleware to check API key
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  
  if (apiKey !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  next();
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'inbox-api' });
});

// Upload endpoint
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
      path: `vault/inbox/${filename}`,
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

// Start server
const PORT = process.env.INBOX_API_PORT || 3333;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Inbox API listening on port ${PORT}`);
  console.log(`API Key: ${API_KEY}`);
  console.log('\nTo test:');
  console.log(`curl -X POST http://localhost:${PORT}/inbox/upload \\`);
  console.log(`  -H "X-API-Key: ${API_KEY}" \\`);
  console.log(`  -H "Content-Type: text/plain" \\`);
  console.log(`  -d "# Test Note\\n\\nThis is a test"`);
});
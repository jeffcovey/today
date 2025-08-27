#!/usr/bin/env node

// Vault API - Provides read access to vault files for Drafts sync
// This complements the inbox-api.js for bidirectional sync

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const app = express();
const PORT = process.env.VAULT_API_PORT || 3334;

// Middleware
app.use(express.json({ limit: '10mb' }));

// API key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.INBOX_API_KEY; // Reuse the same API key
  
  if (!apiKey || apiKey !== expectedKey) {
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
          // Get file stats
          const stats = await fs.stat(fullPath);
          files.push({
            path: `vault/${relativePath.replace(/\\/g, '/')}`,
            modified: stats.mtime.toISOString(),
            size: stats.size
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
    
    res.json({
      success: true,
      path: `vault/${requestedPath}`,
      content: content,
      modified: stats.mtime.toISOString(),
      size: stats.size
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
        
        results[requestedPath] = {
          content: content,
          modified: stats.mtime.toISOString(),
          size: stats.size
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

// Get file dates index
app.get('/vault/file-dates', authenticateApiKey, async (req, res) => {
  try {
    const indexPath = path.join(projectRoot, '.file-dates.json');
    const content = await fs.readFile(indexPath, 'utf8');
    const index = JSON.parse(content);
    
    res.json({
      success: true,
      count: Object.keys(index).length,
      index: index
    });
  } catch (error) {
    console.error('Error reading file dates index:', error);
    res.status(500).json({
      error: 'Failed to read file dates index',
      message: error.message
    });
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
  console.log(`Health check: http://127.0.0.1:${PORT}/health`);
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
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
import { getDatabase } from './database-service.js';
import { replaceTagsWithEmojis } from './tag-emoji-mappings.js';
import { getMarkdownFileCache } from './markdown-file-cache.js';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Web server only needs read-only access, disable Turso sync for faster startup
const getReadOnlyDatabase = () => getDatabase('.data/today.db', { autoSync: false });

const app = express();
const PORT = process.env.WEB_PORT || 3000;
app.set("trust proxy", 1);
const VAULT_PATH = path.join(__dirname, '..', 'vault');

// Track pending markdown regenerations
const pendingMarkdownUpdates = new Map();
const MARKDOWN_UPDATE_DELAY = 3000; // 3 seconds

// Function to regenerate markdown file sections
async function regenerateMarkdownSections(filePath) {
  try {
    console.log(`Regenerating markdown sections for: ${filePath}`);
    const { execSync } = await import('child_process');
    
    // Run the tasks sync command to regenerate the markdown
    execSync('bin/tasks sync --quick', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe'
    });
    
    console.log(`Markdown sections regenerated for: ${filePath}`);
  } catch (error) {
    console.error(`Failed to regenerate markdown for ${filePath}:`, error.message);
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
  console.log(`Scheduled markdown update for ${filePath} in ${MARKDOWN_UPDATE_DELAY}ms`);
}

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
  /* Custom styles to complement MDBootstrap - v${Date.now()} */
  
  /* Sticky card header with TOC */
  .card-header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: white;
  }
  
  /* Add scroll padding to account for sticky header and navbar */
  html {
    scroll-padding-top: 200px; /* Increased to account for navbar + sticky header */
  }
  
  /* Ensure anchor targets are visible */
  [id]:target {
    scroll-margin-top: 200px;
  }
  
  /* Table of Contents styles in header */
  .card-header .toc-header {
    margin-bottom: 0;
  }
  
  .toc-header summary {
    color: #6c757d;
    font-weight: 500;
    transition: color 0.3s;
  }
  
  .toc-header summary:hover {
    color: #495057;
  }
  
  .toc-header .toc-links {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid #dee2e6;
    border-radius: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: #f8f9fa;
    margin-top: 0.25rem;
  }
  
  .toc-links a {
    color: #495057;
    text-decoration: none;
    transition: all 0.3s;
    display: inline-block;
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.85rem;
    line-height: 1.2;
  }
  
  .toc-links a:hover {
    color: #007bff;
    background: white;
  }
  
  /* Table of Contents styles */
  details summary.h5 {
    color: #007bff;
    font-weight: 500;
  }
  
  details summary.h5:hover {
    color: #0056b3;
  }
  
  .toc-links a {
    color: #495057;
    transition: color 0.2s;
    text-decoration: none;
  }
  
  .toc-links a:hover {
    color: #007bff;
    text-decoration: underline;
  }
  
  /* Smooth scrolling for anchor links */
  html {
    scroll-behavior: smooth;
  }
  
  /* Styles for collapse components that replace details elements */
  .collapse-header {
    transition: all 0.3s ease;
  }

  /* Styles for collapsible task sections */
  details.task-section {
    margin: 1rem 0;
    border: 1px solid #dee2e6;
    border-radius: 0.5rem;
    background: white;
    padding: 0.75rem;
  }

  details.task-section summary {
    cursor: pointer;
    padding: 0.5rem;
    margin: -0.75rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    transition: background-color 0.2s;
    user-select: none;
  }

  details.task-section summary:hover {
    background-color: #f8f9fa;
  }

  details.task-section[open] summary {
    border-bottom: 1px solid #dee2e6;
    margin-bottom: 0.75rem;
    border-radius: 0.5rem 0.5rem 0 0;
  }

  details.task-section .section-content {
    padding-top: 0.75rem;
  }

  /* Style the summary arrow */
  details.task-section summary::-webkit-details-marker {
    margin-right: 0.5rem;
  }

  /* Obsidian-style callout variations */
  details.callout-note {
    border-left: 4px solid #007bff;
  }

  details.callout-tip {
    border-left: 4px solid #28a745;
  }

  details.callout-warning {
    border-left: 4px solid #ffc107;
  }

  details.callout-danger {
    border-left: 4px solid #dc3545;
  }

  details.callout-info {
    border-left: 4px solid #17a2b8;
  }

  details.callout-success,
  details.callout-check,
  details.callout-done {
    border-left: 4px solid #28a745;
  }

  details.callout-abstract,
  details.callout-summary,
  details.callout-tldr {
    border-left: 4px solid #00b0ff;
  }

  details.callout-hint,
  details.callout-important {
    border-left: 4px solid #00bcd4;
  }

  details.callout-question,
  details.callout-help,
  details.callout-faq {
    border-left: 4px solid #ffc107;
  }

  details.callout-caution,
  details.callout-attention {
    border-left: 4px solid #ff9800;
  }

  details.callout-failure,
  details.callout-fail,
  details.callout-missing,
  details.callout-error,
  details.callout-bug {
    border-left: 4px solid #f44336;
  }

  details.callout-cite {
    border-left: 4px solid #9e9e9e;
  }

  body {
    background-color: #f5f5f5;
    min-height: 100vh;
  }
  
  /* Only apply background to markdown content that's NOT in a chat bubble */
  .markdown-content:not(.chat-bubble .markdown-content) {
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
    background: #1e1e1e;
    color: #d4d4d4;
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
    color: #d4d4d4;
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
  
  /* Task styles */
  .task-cancelled {
    text-decoration: line-through;
    opacity: 0.6;
    color: #6c757d;
  }

  .task-cancelled input[type="checkbox"] {
    opacity: 1;
  }

  /* Add "(cancelled)" text indicator to cancelled tasks */
  .task-cancelled::after {
    content: " (cancelled)";
    font-style: italic;
    color: #6c757d;
  }

  /* Properties card styles */
  .properties-card {
    border-left: 4px solid #1266f1;
  }

  .properties-card .card-header {
    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
  }

  .properties-card .badge {
    font-weight: normal;
  }

  .properties-card details summary {
    cursor: pointer;
    user-select: none;
    transition: color 0.2s;
  }

  .properties-card details summary:hover {
    opacity: 0.8;
  }

  .properties-card .progress {
    background-color: #e9ecef;
  }

  .properties-card .progress-bar {
    background-color: #1266f1;
    transition: width 0.6s ease;
  }

  .properties-card time {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    font-size: 0.9em;
    color: #495057;
  }

  /* Dataview styles */
  .dataview-table {
    width: 100%;
    margin: 1.5rem 0;
    border-collapse: collapse;
  }

  .dataview-table thead {
    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
    border-bottom: 2px solid #1266f1;
  }

  .dataview-table th {
    padding: 0.75rem 1rem;
    text-align: left;
    font-weight: 600;
    color: #212529;
    border-bottom: 2px solid #dee2e6;
  }

  .dataview-table td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #dee2e6;
  }

  .dataview-table tbody tr:hover {
    background-color: #f8f9fa;
  }

  .dataview-table tbody tr:last-child td {
    border-bottom: none;
  }

  .dataview-list {
    margin: 1rem 0;
    padding-left: 1.5rem;
  }

  .dataview-list li {
    margin: 0.5rem 0;
  }

  .dataview-inline {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
    font-size: 0.9em;
    background-color: #f8f9fa;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
  }

  /* Chat interface styles */
  .chat-container {
    height: calc(100vh - 250px);
    max-height: 600px;
    display: flex;
    flex-direction: column;
  }
  
  /* AI Assistant Card Container */
  .ai-assistant-wrapper {
    transition: all 0.3s ease;
  }
  
  /* When AI assistant is collapsed, expand main content */
  @media (min-width: 992px) {
    .ai-assistant-wrapper.collapsed ~ .col-lg-7,
    .col-lg-7:has(~ .ai-assistant-wrapper.collapsed) {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      transition: all 0.3s ease;
    }

    /* Hide the collapsed column */
    .ai-assistant-wrapper.collapsed {
      flex: 0 0 0 !important;
      max-width: 0 !important;
      overflow: hidden;
      padding: 0 !important;
    }
  }
  
  /* Make chat card sticky on desktop */
  @media (min-width: 992px) {
    .col-lg-5 > .card {
      position: sticky;
      top: 1rem;
      max-height: calc(100vh - 2rem);
    }
    
    /* When collapsed, show floating toggle button */
    .ai-assistant-wrapper.collapsed .card {
      position: fixed;
      right: -450px;
      top: 50%;
      transform: translateY(-50%);
      width: 450px;
      z-index: 1050;
      transition: right 0.3s ease;
      box-shadow: -2px 0 10px rgba(0,0,0,0.15);
    }

    .ai-assistant-wrapper.collapsed .toggle-btn {
      position: fixed;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 40px;
      height: 80px;
      border-radius: 8px;
      background: #007bff;
      color: white;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: -2px 0 5px rgba(0,0,0,0.1);
      z-index: 1051;
    }

    /* Show card on hover */
    .ai-assistant-wrapper.collapsed:hover .card {
      right: 0;
    }
  }
  
  /* Mobile styles */
  @media (max-width: 991px) {
    /* Collapsed state - slides to the bottom */
    .ai-assistant-wrapper.collapsed .card {
      position: fixed;
      bottom: -100%;
      left: 0;
      right: 0;
      width: 100%;
      z-index: 1050;
      transform: translateY(calc(100% - 50px));
      transition: transform 0.3s ease;
      max-height: 70vh;
    }
    
    .ai-assistant-wrapper.collapsed .card-header {
      cursor: pointer;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.15);
    }
    
    .ai-assistant-wrapper.collapsed .chat-container {
      display: none;
    }
  }
  
  /* Toggle button styles */
  .toggle-btn {
    background: transparent;
    border: none;
    color: white;
    cursor: pointer;
    padding: 0.25rem;
    margin-left: auto;
    transition: transform 0.3s ease;
  }
  
  .toggle-btn:hover {
    transform: scale(1.1);
  }
  
  /* Hide button on mobile in favor of header click */
  @media (max-width: 991px) {
    .toggle-btn.desktop-only {
      display: none;
    }
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
  .chat-bubble .markdown-content {
    background: transparent !important;
    background-color: transparent !important;
    border: none !important;
    box-shadow: none !important;
    padding: 0 !important;
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
  .chat-bubble pre {
    background: #282c34 !important;
    border: 1px solid #3e4451 !important;
    margin: 0.5rem 0 !important;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
  }
  
  .chat-bubble pre code {
    background: #282c34 !important;
    color: #abb2bf !important;
    padding: 0.75rem !important;
    border-radius: 0.25rem !important;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
    display: block !important;
    overflow-x: auto !important;
  }
  
  .chat-bubble.user pre {
    background: #f5f5f5 !important;
    border: 1px solid #ccc !important;
  }
  
  .chat-bubble.user pre code {
    background: #f5f5f5 !important;
    color: #333 !important;
  }
  
  .chat-bubble.assistant pre,
  .chat-bubble.ai pre {
    background: #1e1e1e !important;
  }
  
  .chat-bubble.assistant pre code,
  .chat-bubble.ai pre code {
    background: #282c34 !important;
    color: #abb2bf !important;
  }
  
  /* Inline code styling */
  .chat-bubble code:not(pre code) {
    background: rgba(0,0,0,0.75) !important;
    color: #e6e6e6 !important;
    padding: 0.125rem 0.25rem !important;
    border-radius: 3px !important;
    font-size: 0.9em !important;
  }
  
  .chat-bubble.user code:not(pre code) {
    background: rgba(0,0,0,0.1) !important;
    color: #333 !important;
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
    min-height: 100px !important;
    height: auto !important;
  }
  
  .chat-input-area .btn {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    align-self: stretch;
  }
  
  /* Card body with markdown content - natural flow */
  .card-body.markdown-content {
    /* Remove fixed height to allow natural flow */
    padding: 1.5rem;
  }
  
  /* Sticky navbar and breadcrumb */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 1020;
  }
  
  nav[aria-label="breadcrumb"] {
    position: sticky;
    top: 56px;
    background: transparent;
    z-index: 1010;
    padding: 0.5rem 0;
    margin-bottom: 1rem;
  }
  
  @media (max-width: 768px) {
    .chat-container {
      height: 40vh;
    }
    
    .card-body.markdown-content {
      /* Natural flow on mobile too */
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
      <!-- Navbar -->
      <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container-fluid">
          <a class="navbar-brand" href="/">
            <i class="fas fa-folder-open me-2"></i>Vault Browser
          </a>
          <form class="d-flex ms-auto" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput" style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit">
                <i class="fas fa-search"></i>
              </button>
            </div>
          </form>
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

        <!-- Time Tracking -->
        ${currentTimer ? `
        <div class="alert alert-info d-flex align-items-center mb-3" role="alert" data-timer-start="${currentTimer.startTimeISO}">
          <i class="fas fa-clock me-2"></i>
          <div class="flex-grow-1">
            <strong>${currentTimer.description}</strong>
            <br>
            <small>Started at ${currentTimer.startTime} • Duration: <span class="timer-duration">${currentTimer.duration}</span></small>
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
        </div>
        <script>
          (function() {
            // Update timer duration every second
            function updateTimerDuration() {
              const timerEl = document.querySelector('[data-timer-start]');
              if (!timerEl) return;

              const startTime = new Date(timerEl.dataset.timerStart);
              const now = new Date();
              const durationMs = now - startTime;
              const hours = Math.floor(durationMs / (1000 * 60 * 60));
              const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));

              const durationText = hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm';
              const durationSpan = timerEl.querySelector('.timer-duration');
              if (durationSpan) {
                durationSpan.textContent = durationText;
              }
            }

            // Only start interval if not already running
            if (!window.timerIntervalStarted) {
              window.timerIntervalStarted = true;
              updateTimerDuration();
              setInterval(updateTimerDuration, 1000);
            }
          })();
        </script>
        ` : `
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
        </div>
        `}

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-lg-7 mb-3">
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

      // Query database for tasks with scheduled or due dates for today
      // Looking for tasks with ⏳ YYYY-MM-DD or 📅 YYYY-MM-DD that are not done
      const taskRows = db.prepare(`
        SELECT COUNT(*) as count
        FROM markdown_tasks
        WHERE line_text LIKE '- [ ] %'
          AND (line_text LIKE '%⏳ ${todayISO}%' OR line_text LIKE '%📅 ${todayISO}%')
      `).get();

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
              <a href="/tasks-today.md" class="list-group-item list-group-item-action ${taskCount > 0 ? 'bg-warning' : 'bg-secondary'} text-white">
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
    <div class="col-12 col-lg-5 mb-3">
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
                onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
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
        // Search functionality
        function performSearch(event) {
          event.preventDefault();
          const searchQuery = document.getElementById('searchInput').value.trim();
          if (searchQuery) {
            window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
          }
        }
        
        // AI Assistant Toggle Functionality for Directory View
        let isCollapsed = false;
        
        // Check if mobile and set default collapsed state
        function initializeAIAssistant() {
          const isMobile = window.innerWidth <= 991;
          const savedState = localStorage.getItem('aiAssistantCollapsed');
          
          // Default to collapsed on mobile, expanded on desktop
          if (savedState !== null) {
            isCollapsed = savedState === 'true';
          } else {
            isCollapsed = isMobile;
          }
          
          if (isCollapsed) {
            document.body.classList.add('ai-collapsed');
            updateToggleIcon();
          }

          // Add click handler for mobile header
          if (isMobile) {
            const header = document.getElementById('aiAssistantHeader');
            header.style.cursor = 'pointer';
            header.onclick = toggleAIAssistant;
          }
        }
        
        function toggleAIAssistant() {
          isCollapsed = !isCollapsed;

          if (isCollapsed) {
            document.body.classList.add('ai-collapsed');
          } else {
            document.body.classList.remove('ai-collapsed');
          }

          updateToggleIcon();
          localStorage.setItem('aiAssistantCollapsed', isCollapsed);
        }
        
        function updateToggleIcon() {
          const icon = document.getElementById('toggleIcon');
          if (icon) {
            const isMobile = window.innerWidth <= 991;
            if (isMobile) {
              icon.className = isCollapsed ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
            } else {
              icon.className = isCollapsed ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
            }
          }
        }
        
        // Handle resize events
        let resizeTimeout;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            updateToggleIcon();
          }, 250);
        });
        
        // Initialize on page load
        document.addEventListener('DOMContentLoaded', initializeAIAssistant);
        
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
          
          // Create renderer for external links
          const renderer = new marked.Renderer();
          const originalLink = renderer.link.bind(renderer);
          renderer.link = function(href, title, text) {
            const isExternal = /^https?:\/\//.test(href);
            let link = originalLink(href, title, text);
            if (isExternal) {
              link = link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
            }
            return link;
          };
          
          // Render markdown using marked with custom renderer
          const renderedContent = marked.parse(message, { renderer });
          
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
          font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
          font-size: 14px;
          line-height: 1.6;
          padding: 1rem;
          resize: none;
        }
        #editor:focus {
          outline: none;
          box-shadow: none;
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
          <form class="d-flex ms-auto" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput" style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit">
                <i class="fas fa-search"></i>
              </button>
            </div>
          </form>
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

      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
      
      <script>
        // Search functionality
        function performSearch(event) {
          event.preventDefault();
          const searchQuery = document.getElementById('searchInput').value.trim();
          if (searchQuery) {
            window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
          }
        }
        
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

// Generate table of contents from markdown headings
function generateTableOfContents(content) {
  const headings = [];
  const headingRegex = /^(#{2,6})\s+(.+)$/gm;
  let match;
  let headingId = 0;
  
  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    // Skip if heading is inside a details/summary block
    const beforeMatch = content.substring(0, match.index);
    const openDetails = (beforeMatch.match(/<details/gi) || []).length;
    const closeDetails = (beforeMatch.match(/<\/details>/gi) || []).length;
    if (openDetails > closeDetails) continue;
    
    headingId++;
    const id = `heading-${headingId}`;
    headings.push({ level, text, id });
  }
  
  if (headings.length === 0) return { toc: '', contentWithIds: content };
  
  // Generate TOC HTML for header
  let tocHtml = '';
  tocHtml += '<details class="toc-header">\n';
  tocHtml += '<summary class="text-muted small" style="cursor: pointer; user-select: none;"><i class="fas fa-list me-1"></i>Table of Contents</summary>\n';
  tocHtml += '<div class="toc-links mt-1">\n';
  tocHtml += '<ul class="list-unstyled small mb-0">\n';

  headings.forEach(heading => {
    const indent = (heading.level - 2) * 15; // Start from h2, each level adds 15px (reduced from 20px)
    tocHtml += `<li style="margin-left: ${indent}px; margin-bottom: 0.15rem; line-height: 1.3;">`;
    tocHtml += `<a href="#${heading.id}">`;
    tocHtml += heading.text;
    tocHtml += '</a></li>\n';
  });
  
  tocHtml += '</ul>\n';
  tocHtml += '</div>\n';
  tocHtml += '</details>\n';
  
  // Add IDs to headings in content
  headingId = 0;
  const contentWithIds = content.replace(headingRegex, (match, hashes, text) => {
    headingId++;
    return `${hashes} <span id="heading-${headingId}"></span>${text}`;
  });
  
  return { toc: tocHtml, contentWithIds };
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
    // Skip notion_ prefixed properties (too many, not that useful)
    if (key.startsWith('notion_')) continue;

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
    return `<p>${text}</p>`;
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
    return mapped;
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
        log: (...args) => console.log('[DataviewJS]', ...args),
        error: (...args) => console.error('[DataviewJS]', ...args)
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

    return output;
  } catch (error) {
    console.error('DataviewJS execution error:', error);
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
      console.log(`[DEBUG] Executing dataviewjs block`);
      const html = await executeDataviewJS(code, vaultPath, currentFilePath);

      // Replace the code block with the rendered HTML
      processedContent = processedContent.replace(fullMatch, html);
    } catch (error) {
      console.error('[DEBUG] Error executing dataviewjs block:', error);
      const errorHtml = `<div class="alert alert-danger" role="alert">
        <strong>Dataview Error:</strong> ${error.message}
      </div>`;
      processedContent = processedContent.replace(fullMatch, errorHtml);
    }
  }

  return processedContent;
}

// Process inline dataview expressions ($= syntax)
async function processInlineDataview(content, properties, vaultPath, currentFilePath) {
  // Match $= expressions inside backticks: `$= expression`
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
      console.error('[DEBUG] Error processing inline dataview:', error);
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
    console.log(`[TASK QUERY CACHE HIT] ${filters.join(', ')}`);
    return cached.result;
  }

  // Build optimized SQL query with WHERE clauses
  let sqlWhere = [`file_path NOT LIKE '%/.%'`,
                  `file_path NOT LIKE '%/@inbox/%'`,
                  `file_path NOT LIKE '%/node_modules/%'`];
  let needsJsFiltering = false;
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const todayStr = todayDate.toISOString().split('T')[0];

  // Analyze filters to build SQL WHERE clauses
  for (const filter of filters) {
    if (filter === 'done') {
      sqlWhere.push(`line_text LIKE '- [x]%' OR line_text LIKE '- [X]%'`);
    } else if (filter === 'not done') {
      sqlWhere.push(`line_text LIKE '- [ ]%'`);
    } else if (filter === 'done today') {
      // Optimize for "done today" - the most common query
      sqlWhere.push(`(line_text LIKE '- [x]%' OR line_text LIKE '- [X]%')`);
      sqlWhere.push(`line_text LIKE '%✅ ${todayStr}%'`);
    } else if (filter.startsWith('path includes ')) {
      const pathPattern = filter.replace('path includes ', '').trim();
      sqlWhere.push(`file_path LIKE '%${pathPattern}%'`);
    } else if (filter.startsWith('path does not include ')) {
      const pathPattern = filter.replace('path does not include ', '').trim();
      sqlWhere.push(`file_path NOT LIKE '%${pathPattern}%'`);
    } else {
      // Complex filters need JavaScript processing
      needsJsFiltering = true;
    }
  }

  // Get filtered tasks from database
  let taskRows;
  try {
    const sql = `
      SELECT file_path, line_number, line_text
      FROM markdown_tasks
      WHERE ${sqlWhere.join(' AND ')}
    `;
    taskRows = db.prepare(sql).all();
    console.log(`[DEBUG] SQL filtered: ${taskRows.length} tasks (from ~6600 total)`);
  } catch (error) {
    console.error('[DEBUG] Error querying database:', error.message);
    taskRows = [];
  }

  // Parse each task line
  const tasks = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const row of taskRows) {
    const filePath = row.file_path;
    const lineNumber = row.line_number;
    const content = row.line_text;

    // Parse task checkbox state (accounting for indentation and blockquote markers)
    const isDone = /^(?:>\s*)?-?\s*- \[[xX]\]/.test(content);
    const isCancelled = /^(?:>\s*)?-?\s*- \[-\]/.test(content);
    const taskText = content.replace(/^(?:>\s*)?-?\s*- \[[ xX-]\] /, '');

    // Parse dates
    let scheduledDate = null;
    let dueDate = null;
    let doneDate = null;

    const scheduledMatch = taskText.match(/⏳ (\d{4}-\d{2}-\d{2})/);
    if (scheduledMatch) scheduledDate = new Date(scheduledMatch[1] + 'T00:00:00');

    const dueMatch = taskText.match(/📅 (\d{4}-\d{2}-\d{2})/);
    if (dueMatch) dueDate = new Date(dueMatch[1] + 'T00:00:00');

    const doneMatch = taskText.match(/✅ (\d{4}-\d{2}-\d{2})/);
    if (doneMatch) doneDate = new Date(doneMatch[1] + 'T00:00:00');

    // Parse priority
    let priority = 0;
    if (taskText.includes('🔺')) priority = 3;
    else if (taskText.includes('🔼')) priority = 2;
    else if (taskText.includes('⏫')) priority = 1;

    // Clean task text for display
    let cleanText = taskText
      .replace(/[⏳📅✅➕] \d{4}-\d{2}-\d{2}/g, '')
      .replace(/🔺|🔼|⏫/g, '')
      .replace(/🔁 .+/g, '')
      .replace(/<!--.*?-->/g, '')
      .trim();

    tasks.push({
      filePath: filePath.replace('/opt/today/vault/', '').replace('vault/', ''),
      lineNumber: lineNumber,
      text: cleanText,
      originalText: taskText,
      isDone,
      isCancelled,
      scheduledDate,
      dueDate,
      doneDate,
      priority,
      happens: scheduledDate || dueDate
    });
  }

  // Apply filters
  let filtered = tasks;
  for (const filter of filters) {
    const beforeCount = filtered.length;
    if (filter === 'not done') {
      filtered = filtered.filter(t => !t.isDone);
    } else if (filter === 'done') {
      filtered = filtered.filter(t => t.isDone);
    } else if (filter === 'done today') {
      // Only include tasks that have a done date AND it's today
      // Tasks without done dates should NOT be included
      const todayStr = today.toDateString();
      filtered = filtered.filter(t => {
        if (!t.doneDate) {
          return false; // No done date = not done today
        }
        const taskDateStr = t.doneDate.toDateString();
        const matches = taskDateStr === todayStr;
        return t.isDone && matches;
      });
      console.log(`[DEBUG] "done today" filter: ${beforeCount} -> ${filtered.length} tasks (today: ${todayStr})`);
    } else if (filter.startsWith('path includes ')) {
      const pathPattern = filter.replace('path includes ', '').trim();
      filtered = filtered.filter(t => t.filePath.includes(pathPattern));
    } else if (filter.startsWith('path does not include ')) {
      const pathPattern = filter.replace('path does not include ', '').trim();
      filtered = filtered.filter(t => !t.filePath.includes(pathPattern));
    } else if (filter === 'no scheduled date') {
      filtered = filtered.filter(t => !t.scheduledDate);
    } else if (filter === 'no due date') {
      filtered = filtered.filter(t => !t.dueDate);
    } else if (filter.includes('OR')) {
      // Handle OR conditions
      const conditions = filter.split('OR').map(c => c.replace(/[()]/g, '').trim());
      filtered = filtered.filter(task => {
        return conditions.some(cond => {
          if (cond === 'scheduled before tomorrow') {
            return task.scheduledDate && task.scheduledDate < tomorrow;
          } else if (cond === 'due before tomorrow') {
            return task.dueDate && task.dueDate < tomorrow;
          } else if (cond === 'scheduled after today') {
            return task.scheduledDate && task.scheduledDate > today;
          } else if (cond === 'due after tomorrow') {
            return task.dueDate && task.dueDate > tomorrow;
          }
          return false;
        });
      });
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
  } else if (groupBy && groupBy.includes('function')) {
    // Simple implementation for grouping by file path
    // This handles "group by function task.file.path.toUpperCase().replace(query.file.folder, ': ')"
    const grouped = new Map();
    for (const task of filtered) {
      // Group by file path, removing common prefixes
      let key = task.filePath.toUpperCase();
      // Remove common folder prefixes like "plans/" if present
      if (key.includes('PLANS/')) {
        key = key.replace('PLANS/', '');
      }
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(task);
    }

    // Sort groups alphabetically
    const sortedGroups = Array.from(grouped.entries()).sort((a, b) => {
      return a[0].localeCompare(b[0]);
    });

    const result = { grouped: sortedGroups, groupType: 'custom' };
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
      console.log(`[DEBUG] Skipping tasks block in blockquote`);
      continue;
    }

    matches.push({
      fullMatch: match[0],
      query: match[1]
    });
  }

  console.log(`[DEBUG] Found ${matches.length} tasks code blocks to process`);

  // Process each match
  for (const { fullMatch, query } of matches) {
    console.log(`[DEBUG] Processing query:`, query);
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
          // Add data attributes with file path and line number for future actions
          // Store full path in data-file and line number in data-line
          const relativeFilePath = task.filePath.replace('/opt/today/vault/', '').replace(/^\/workspaces\/today\/vault\//, '');

          // Look up task ID from database to create clickable link
          let taskLink = '';
          try {
            const db = getReadOnlyDatabase();
            // Database stores paths with 'vault/' prefix
            const dbFilePath = 'vault/' + relativeFilePath;
            const dbTask = db.prepare('SELECT id FROM markdown_tasks WHERE file_path = ? AND line_number = ?')
              .get(dbFilePath, task.lineNumber);
            if (dbTask) {
              taskLink = `/task/${dbTask.id}`;
            }
          } catch (error) {
            console.error('Error looking up task ID:', error);
          }

          replacement += `<li data-file="${relativeFilePath}" data-line="${task.lineNumber}" class="${taskClass}">`;
          replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-file="${relativeFilePath}" data-line="${task.lineNumber}"> `;
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
          // Add data attributes with file path and line number for future actions
          // Store full path in data-file and line number in data-line
          const relativeFilePath = task.filePath.replace('/opt/today/vault/', '').replace(/^\/workspaces\/today\/vault\//, '');

          // Look up task ID from database to create clickable link
          let taskLink = '';
          try {
            const db = getReadOnlyDatabase();
            // Database stores paths with 'vault/' prefix
            const dbFilePath = 'vault/' + relativeFilePath;
            const dbTask = db.prepare('SELECT id FROM markdown_tasks WHERE file_path = ? AND line_number = ?')
              .get(dbFilePath, task.lineNumber);
            if (dbTask) {
              taskLink = `/task/${dbTask.id}`;
            }
          } catch (error) {
            console.error('Error looking up task ID:', error);
          }

          replacement += `<li data-file="${relativeFilePath}" data-line="${task.lineNumber}" class="${taskClass}">`;
          replacement += `<input type="checkbox" ${checkbox} class="task-checkbox" data-file="${relativeFilePath}" data-line="${task.lineNumber}"> `;
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
  console.log('[DEBUG] renderMarkdown called for:', urlPath);
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

  // Process tasks code blocks before rendering (but skip ones in blockquotes)
  content = await processTasksCodeBlocks(content, true);

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

  // Generate table of contents
  const { toc, contentWithIds } = generateTableOfContents(contentToRender);
  contentToRender = contentWithIds;

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

  // Render the markdown with custom renderer (with IDs added to headings)
  let htmlContent = marked.parse(contentToRender, { renderer });
  
  // Don't prepend TOC to content - we'll add it to the header instead
  
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
      console.log(`[DEBUG] Processing Obsidian callout with tasks query`);

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
            const relativeFilePath = task.filePath.replace('/opt/today/vault/', '').replace(/^\/workspaces\/today\/vault\//, '');
            tasksHtml += `<li data-file="${relativeFilePath}" data-line="${task.lineNumber}" class="${taskClass}">`;
            tasksHtml += `<input type="checkbox" ${checkbox} class="task-checkbox" data-file="${relativeFilePath}" data-line="${task.lineNumber}"> `;
            tasksHtml += `${priorityIcon}${displayText}`;
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
            const relativeFilePath = task.filePath.replace('/opt/today/vault/', '').replace(/^\/workspaces\/today\/vault\//, '');
            tasksHtml += `<li data-file="${relativeFilePath}" data-line="${task.lineNumber}" class="${taskClass}">`;
            tasksHtml += `<input type="checkbox" ${checkbox} class="task-checkbox" data-file="${relativeFilePath}" data-line="${task.lineNumber}"> `;
            tasksHtml += `${priorityIcon}${displayText}`;
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

  // Enhance remaining blockquotes with MDBootstrap styling
  htmlContent = htmlContent.replace(/<blockquote>/g, '<blockquote class="blockquote border-start border-4 border-primary ps-3 my-3">');
  
  // Enhance code blocks with better styling - using inline styles to override
  htmlContent = htmlContent.replace(/<pre><code class="language-([^"]*)">([\s\S]*?)<\/code><\/pre>/g, 
    '<pre style="background: #1e1e1e !important; color: #d4d4d4 !important; padding: 1rem !important; border: 1px solid #333 !important; border-radius: 0.375rem !important; overflow-x: auto !important;"><code class="language-$1" style="background: transparent !important; color: #d4d4d4 !important;">$2</code></pre>');
  
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
  // This handles tasks from generated files like tasks-today.md that have task-id comments
  // but don't have data-task-id or data-file attributes
  htmlContent = htmlContent.replace(
    /<li>(<input[^>]*type="checkbox"[^>]*>)\s*(.*?)<!--\s*task-id:\s*([a-f0-9]{32})\s*--><\/li>/gi,
    (match, checkbox, taskContent, taskId) => {
      // Look up the task in the markdown_tasks cache to create a link
      try {
        const db = getReadOnlyDatabase();
        const task = db.prepare('SELECT id FROM markdown_tasks WHERE id = ?').get(taskId);

        if (task) {
          // Wrap task text in link
          return `<li>${checkbox} <a href="/task/${taskId}" style="text-decoration: none; color: inherit;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${taskContent.trim()}</a><!-- task-id: ${taskId} --></li>`;
        }
      } catch (error) {
        console.error('Error looking up task by ID:', error);
      }

      // If lookup fails, return original
      return match;
    }
  );

  // Make markdown tasks clickable - wrap task text in link to task detail page
  // Look up task IDs from database and create links
  const taskLinkMatches = [];
  const taskLinkRegex = /<li[^>]*data-file="([^"]+)"[^>]*data-line="(\d+)"[^>]*>(.*?)<\/li>/gi;
  let taskMatch;

  while ((taskMatch = taskLinkRegex.exec(htmlContent)) !== null) {
    const [fullMatch, dataFile, dataLine, liContent] = taskMatch;

    // Look up task ID from database
    try {
      const db = getReadOnlyDatabase();
      // Database stores paths with 'vault/' prefix
      const dbFilePath = 'vault/' + dataFile;
      const task = db.prepare('SELECT id FROM markdown_tasks WHERE file_path = ? AND line_number = ?')
        .get(dbFilePath, parseInt(dataLine));

      if (task) {
        taskLinkMatches.push({
          fullMatch,
          dataFile,
          dataLine,
          liContent,
          taskId: task.id
        });
      }
    } catch (error) {
      // Database lookup failed, skip this task
      console.error('Error looking up task:', error);
    }
  }

  // Replace task list items with clickable versions
  for (const match of taskLinkMatches) {
    // Extract checkbox and task content
    const checkboxMatch = match.liContent.match(/(<input[^>]*>)(.*)/i);
    if (checkboxMatch) {
      const checkbox = checkboxMatch[1];
      let taskContent = checkboxMatch[2].trim();

      // Wrap task text in link (but not the checkbox)
      const clickableTask = `<li data-file="${match.dataFile}" data-line="${match.dataLine}">${checkbox} <a href="/task/${match.taskId}" style="text-decoration: none; color: inherit;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${taskContent}</a></li>`;

      htmlContent = htmlContent.replace(match.fullMatch, clickableTask);
    }
  }

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
          <form class="d-flex ms-auto" onsubmit="performSearch(event)">
            <div class="input-group">
              <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput" style="max-width: 250px;">
              <button class="btn btn-light btn-sm" type="submit">
                <i class="fas fa-search"></i>
              </button>
            </div>
          </form>
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

        <!-- Time Tracking -->
        ${currentTimer ? `
        <div class="alert alert-info d-flex align-items-center mb-3" role="alert" data-timer-start="${currentTimer.startTimeISO}">
          <i class="fas fa-clock me-2"></i>
          <div class="flex-grow-1">
            <strong>${currentTimer.description}</strong>
            <br>
            <small>Started at ${currentTimer.startTime} • Duration: <span class="timer-duration">${currentTimer.duration}</span></small>
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
        </div>
        <script>
          (function() {
            // Update timer duration every second
            function updateTimerDuration() {
              const timerEl = document.querySelector('[data-timer-start]');
              if (!timerEl) return;

              const startTime = new Date(timerEl.dataset.timerStart);
              const now = new Date();
              const durationMs = now - startTime;
              const hours = Math.floor(durationMs / (1000 * 60 * 60));
              const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));

              const durationText = hours > 0 ? hours + 'h ' + minutes + 'm' : minutes + 'm';
              const durationSpan = timerEl.querySelector('.timer-duration');
              if (durationSpan) {
                durationSpan.textContent = durationText;
              }
            }

            // Only start interval if not already running
            if (!window.timerIntervalStarted) {
              window.timerIntervalStarted = true;
              updateTimerDuration();
              setInterval(updateTimerDuration, 1000);
            }
          })();
        </script>
        ` : `
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
        </div>
        `}

        <div class="row">
          <!-- Content column -->
          <div class="col-12 col-lg-7 mb-3">
            <div class="card shadow-sm h-100">
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
          <div class="col-12 col-lg-5 mb-3">
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
                      onkeypress="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
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
      </div>

      <!-- Floating toggle button to restore AI assistant -->
      <button class="floating-toggle-btn" onclick="toggleAIAssistant()" title="Show AI Assistant">
        <i class="fas fa-chevron-left"></i>
      </button>

      <!-- Marked.js for markdown rendering -->
      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      
      <!-- MDB -->
      <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
      
      <script>
        // Search functionality
        function performSearch(event) {
          event.preventDefault();
          const searchQuery = document.getElementById('searchInput').value.trim();
          if (searchQuery) {
            window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
          }
        }
        
        // AI Assistant Toggle Functionality
        let isCollapsed = false;
        
        // Check if mobile and set default collapsed state
        function initializeAIAssistant() {
          const isMobile = window.innerWidth <= 991;
          const savedState = localStorage.getItem('aiAssistantCollapsed');
          
          // Default to collapsed on mobile, expanded on desktop
          if (savedState !== null) {
            isCollapsed = savedState === 'true';
          } else {
            isCollapsed = isMobile;
          }
          
          if (isCollapsed) {
            document.body.classList.add('ai-collapsed');
            updateToggleIcon();
          }

          // Add click handler for mobile header
          if (isMobile) {
            const header = document.getElementById('aiAssistantHeader');
            header.style.cursor = 'pointer';
            header.onclick = toggleAIAssistant;
          }
        }
        
        function toggleAIAssistant() {
          isCollapsed = !isCollapsed;

          if (isCollapsed) {
            document.body.classList.add('ai-collapsed');
          } else {
            document.body.classList.remove('ai-collapsed');
          }

          updateToggleIcon();
          localStorage.setItem('aiAssistantCollapsed', isCollapsed);
        }
        
        function updateToggleIcon() {
          const icon = document.getElementById('toggleIcon');
          if (icon) {
            const isMobile = window.innerWidth <= 991;
            if (isMobile) {
              icon.className = isCollapsed ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
            } else {
              icon.className = isCollapsed ? 'fas fa-chevron-left' : 'fas fa-chevron-right';
            }
          }
        }
        
        // Handle resize events
        let resizeTimeout;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(() => {
            updateToggleIcon();
          }, 250);
        });
        
        // Initialize on page load
        document.addEventListener('DOMContentLoaded', initializeAIAssistant);
        
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
        
        // Escape HTML for safe display
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
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
          
          // Create renderer for external links
          const renderer = new marked.Renderer();
          const originalLink = renderer.link.bind(renderer);
          renderer.link = function(href, title, text) {
            const isExternal = /^https?:\/\//.test(href);
            let link = originalLink(href, title, text);
            if (isExternal) {
              link = link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
            }
            return link;
          };
          
          // Render markdown using marked with custom renderer
          const renderedContent = marked.parse(message, { renderer });
          
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
          
          // Create initial HTML with space for thinking content
          typingIndicator.innerHTML = \`
            <div class="bubble-content">
              <small class="d-block" style="opacity: 0.6; margin: 0 0 0.05rem 0; font-size: 0.65rem; line-height: 1;">AI · Processing...</small>
              <div class="d-flex align-items-center">
                <div class="spinner-border spinner-border-sm text-secondary me-2" role="status">
                  <span class="visually-hidden">Loading...</span>
                </div>
                <span class="text-muted" id="ai-timer">0 seconds</span>
              </div>
              <div class="thinking-content text-muted small mt-2" style="max-height: 100px; overflow-y: auto; font-family: monospace; display: none;"></div>
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
            
            // Use fetch with streaming response for SSE
            const response = await fetch(\`/ai-chat-stream/${urlPath}\`, {
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
                                <small class="d-block" style="opacity: 0.6; margin: 0 0 0.25rem 0; font-size: 0.65rem; line-height: 1;">AI · Thinking Process</small>
                                <details class="mb-2">
                                  <summary class="text-muted small" style="cursor: pointer;">
                                    <i class="fas fa-brain me-1"></i> View thinking process
                                  </summary>
                                  <div class="mt-2 p-2 bg-light rounded" style="font-family: monospace; font-size: 0.85rem; max-height: 300px; overflow-y: auto;">
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
                            <small class="d-block" style="opacity: 0.6; margin: 0 0 0.25rem 0; font-size: 0.65rem; line-height: 1;">AI · <span id="response-timer">Responding...</span></small>
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
                        // Create renderer for external links
                        const renderer = new marked.Renderer();
                        const originalLink = renderer.link.bind(renderer);
                        renderer.link = function(href, title, text) {
                          const isExternal = /^https?:\/\//.test(href);
                          let link = originalLink(href, title, text);
                          if (isExternal) {
                            link = link.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
                          }
                          return link;
                        };
                        responseElement.innerHTML = marked.parse(responseContent, { renderer });
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
                      
                      // Update timer in response
                      const timerElement = document.getElementById('response-timer');
                      if (timerElement) {
                        timerElement.textContent = 'Replied in ' + timeStr;
                      }
                      
                      // Save to chat history
                      chatHistory.push(
                        { role: 'user', content: message },
                        { role: 'assistant', content: data.fullResponse || responseContent }
                      );
                      saveHistory();
                      
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

// AI Chat route handler  
app.post('/ai-chat/*path', authMiddleware, async (req, res) => {
  // Set timeout for this specific request to 5 minutes
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
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

// SSE endpoint for streaming AI chat responses
app.post('/ai-chat-stream/*path', authMiddleware, async (req, res) => {
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
  });
  
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
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
    
    // Call Claude using the claude CLI with streaming
    const { spawn } = await import('child_process');
    
    console.log('[AI Stream] Starting Claude with streaming...');
    
    // Use spawn with --print for regular output (stream-json might not be supported)
    const claude = spawn('claude', ['--print'], {
      cwd: process.cwd(),
      timeout: 300000 // 5 minute hard timeout
    });
    
    let fullResponse = '';
    let thinkingContent = '';
    let isThinking = false;
    
    claude.stdout.on('data', (data) => {
      const chunk = data.toString();
      
      // For plain text output, just stream it directly
      fullResponse += chunk;
      
      // Send text update to client
      res.write(`data: ${JSON.stringify({
        type: 'text',
        content: chunk
      })}\n\n`);
    });
    
    claude.stderr.on('data', (data) => {
      console.error('[AI Stream] stderr:', data.toString());
    });
    
    // Write the conversation to stdin
    claude.stdin.write(conversation);
    claude.stdin.end();
    
    claude.on('close', async (code) => {
      console.log('[AI Stream] Claude process exited with code:', code);
      
      if (code === 0) {
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
          fileModified: fileModified,
          fullResponse: fullResponse
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: `Process exited with code ${code}`
        })}\n\n`);
      }
      
      clearInterval(keepAlive);
      res.end();
    });
    
    claude.on('error', (err) => {
      console.error('[AI Stream] Failed to start Claude:', err);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        message: err.message
      })}\n\n`);
      clearInterval(keepAlive);
      res.end();
    });
    
  } catch (error) {
    console.error('[AI Stream] Error:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: error.message
    })}\n\n`);
    clearInterval(keepAlive);
    res.end();
  }
});

// AI Chat route handler for directories
app.post('/ai-chat-directory/*path', authMiddleware, async (req, res) => {
  // Set timeout for this specific request to 5 minutes
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  
  try {
    const urlPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path; // Get the wildcard path
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
          <!-- Navbar -->
          <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
            <div class="container-fluid">
              <a class="navbar-brand" href="/">
                <i class="fas fa-search me-2"></i>Search Results
              </a>
              <form class="d-flex ms-auto" onsubmit="performSearch(event)">
                <div class="input-group">
                  <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput" value="${searchQuery.replace(/"/g, '&quot;')}" style="max-width: 250px;">
                  <button class="btn btn-light btn-sm" type="submit">
                    <i class="fas fa-search"></i>
                  </button>
                </div>
              </form>
            </div>
          </nav>
          
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
          
          <script>
            function performSearch(event) {
              event.preventDefault();
              const searchQuery = document.getElementById('searchInput').value.trim();
              if (searchQuery) {
                window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
              }
            }
          </script>
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
          <!-- Navbar -->
          <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
            <div class="container-fluid">
              <a class="navbar-brand" href="/">
                <i class="fas fa-search me-2"></i>Search Results
              </a>
              <form class="d-flex ms-auto" onsubmit="performSearch(event)">
                <div class="input-group">
                  <input class="form-control form-control-sm" type="search" placeholder="Search vault..." aria-label="Search" id="searchInput" value="${searchQuery.replace(/"/g, '&quot;')}" style="max-width: 250px;">
                  <button class="btn btn-light btn-sm" type="submit">
                    <i class="fas fa-search"></i>
                  </button>
                </div>
              </form>
            </div>
          </nav>
          
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
          
          <script>
            function performSearch(event) {
              event.preventDefault();
              const searchQuery = document.getElementById('searchInput').value.trim();
              if (searchQuery) {
                window.location.href = '/search?q=' + encodeURIComponent(searchQuery);
              }
            }
          </script>
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
    console.log(`[TASK] Toggling task - file: ${file}, line: ${line}, completed: ${completed}`);

    // Validate required fields
    if (!file || !line) {
      console.error('[TASK] Missing required fields:', { file, line });
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
      console.error(`[TASK] Line ${line} not found in file with ${lines.length} lines`);
      return res.status(400).json({ error: 'Task line not found' });
    }

    // Validate that this is actually a task line
    // Updated regex to match tasks in blockquotes too
    if (!taskLine.match(/^(?:\s*>)*\s*- \[[ xX]\]/)) {
      console.error(`[TASK] Line ${line} is not a task: "${taskLine}"`);
      return res.status(400).json({ error: 'Not a task line' });
    }

    // Check database cache but don't fail if not found
    const db = getReadOnlyDatabase();
    const cachedTask = db.prepare('SELECT line_text FROM markdown_tasks WHERE file_path = ? AND line_number = ?')
      .get(dbFilePath, line);

    // If we have a cached task, verify it matches (ignoring completion status and date)
    if (cachedTask) {
      // Strip completion markers for comparison
      const normalizeTask = (text) => text
        .replace(/^(?:\s*>)*\s*- \[[xX]\]/, '- [ ]')  // Normalize checkbox to unchecked (including blockquote prefix)
        .replace(/ ✅ \d{4}-\d{2}-\d{2}$/, '');  // Remove completion date

      const normalizedCache = normalizeTask(cachedTask.line_text);
      const normalizedFile = normalizeTask(taskLine);

      if (normalizedCache !== normalizedFile) {
        console.log(`[TASK] Cache mismatch at line ${line}, using file version`);
        console.log(`  Cache: "${cachedTask.line_text}"`);
        console.log(`  File:  "${taskLine}"`);
        // Don't fail - just proceed with the file version
      }
    } else {
      console.log(`[TASK] Task not in cache, proceeding with file version: "${taskLine}"`);
    }

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
        console.log(`[TASK] Processing recurring task with pattern: ${recurrencePattern}`);

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

          console.log(`[TASK] Created new recurring task: ${newTaskLine}`);
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

    // Update the database cache to reflect the change
    try {
      if (cachedTask) {
        // Update existing cache entry
        const updateStmt = db.prepare(`
          UPDATE markdown_tasks
          SET line_text = ?
          WHERE file_path = ? AND line_number = ?
        `);
        updateStmt.run(updatedLine, dbFilePath, line);
        console.log(`[TASK] Updated database cache for ${dbFilePath}:${line}`);
      } else {
        // Insert new cache entry if task wasn't cached
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO markdown_tasks (file_path, line_number, line_text)
          VALUES (?, ?, ?)
        `);
        insertStmt.run(dbFilePath, line, updatedLine);
        console.log(`[TASK] Added to database cache: ${dbFilePath}:${line}`);
      }

      // If we added a new recurring task, also add it to the cache
      if (newTaskLine) {
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO markdown_tasks (file_path, line_number, line_text)
          VALUES (?, ?, ?)
        `);
        insertStmt.run(dbFilePath, line + 1, newTaskLine);
        console.log(`[TASK] Added new recurring task to cache: ${dbFilePath}:${line + 1}`);

        // We should also update line numbers for all tasks after this insertion
        const updateStmt = db.prepare(`
          UPDATE markdown_tasks
          SET line_number = line_number + 1
          WHERE file_path = ? AND line_number > ?
        `);
        updateStmt.run(dbFilePath, line);
        console.log(`[TASK] Updated line numbers for subsequent tasks in cache`);
      }
    } catch (dbError) {
      console.error('[TASK] Failed to update database cache:', dbError);
      // Don't fail the request since the file was updated successfully
    }

    console.log(`[TASK] Successfully updated task at line ${line}`);
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

// Task detail page for markdown tasks
app.get('/task/:taskId', authMiddleware, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const db = getReadOnlyDatabase();

    // Get task from markdown_tasks cache
    const task = db.prepare('SELECT * FROM markdown_tasks WHERE id = ?').get(taskId);

    if (!task) {
      return res.status(404).send('Task not found');
    }

    // Parse the task line to extract details
    const taskText = task.line_text.replace(/^(\s*>)*\s*- \[[x\s-]\]\s*/i, '').trim();

    // Create clean version for timer (remove status tags and dates)
    const cleanTaskText = taskText
      .replace(/#stage\/[^\s]*/g, '')         // Remove #stage/... tags
      .replace(/[⏫🔼🔽⏬]/g, '')              // Remove priority emojis
      .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, '') // Remove ➕ created dates
      .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '') // Remove ⏳ due dates
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '') // Remove 📅 scheduled dates
      .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '') // Remove ✅ done dates
      .replace(/🔁\s*[^\n]*/g, '')            // Remove 🔁 recurrence
      .replace(/\s+/g, ' ')                   // Collapse multiple spaces
      .trim();

    // Strip vault/ prefix from file path for links
    const displayPath = task.file_path.replace(/^vault\//, '');

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>Task: ${taskText.substring(0, 50)}...</title>
        ${pageStyle}
      </head>
      <body>
        <!-- Navbar -->
        <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
          <div class="container-fluid">
            <a class="navbar-brand" href="/">
              <i class="fas fa-tasks me-2"></i>Task Details
            </a>
          </div>
        </nav>

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
                    <p class="fs-5">${taskText}</p>
                  </div>

                  <!-- File Location -->
                  <div class="mb-4">
                    <h6 class="text-muted mb-2">Location</h6>
                    <div>
                      <i class="fas fa-file me-2"></i>
                      <a href="/${displayPath}">${task.file_path}</a>
                      <span class="text-muted ms-2">(line ${task.line_number})</span>
                    </div>
                  </div>

                  <!-- Actions -->
                  <div class="d-flex gap-2 flex-wrap">
                    <a href="/${displayPath}" class="btn btn-primary">
                      <i class="fas fa-file-alt me-2"></i>View File
                    </a>
                    <a href="/edit/${displayPath}" class="btn btn-secondary">
                      <i class="fas fa-edit me-2"></i>Edit File
                    </a>
                    <button class="btn btn-success" onclick="startTimer()">
                      <i class="fas fa-play me-2"></i>Start Timer
                    </button>
                    <button class="btn btn-outline-secondary" onclick="window.history.back()">
                      <i class="fas fa-arrow-left me-2"></i>Back
                    </button>
                  </div>
                </div>
              </div>

              <!-- Raw Task Line -->
              <div class="card mt-3 shadow-sm">
                <div class="card-body">
                  <small class="text-muted">
                    <div class="mb-2"><strong>Task ID:</strong> ${task.id}</div>
                    <div class="mb-2"><strong>Created:</strong> ${new Date(task.created_at).toLocaleString()}</div>
                    <div class="mb-2"><strong>Updated:</strong> ${new Date(task.updated_at).toLocaleString()}</div>
                    <div class="mb-2"><strong>Raw Line:</strong></div>
                    <code class="d-block p-2 bg-light">${task.line_text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>
                  </small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <script>
          function startTimer() {
            const taskText = ${JSON.stringify(cleanTaskText)};
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

        <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
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
        <style>
          .form-label { font-weight: 500; margin-bottom: 0.5rem; }
          .form-control, .form-select { margin-bottom: 1rem; }
          .task-form { max-width: 800px; margin: 0 auto; }
        </style>
      </head>
      <body>
        <!-- Navbar -->
        <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
          <div class="container-fluid">
            <a class="navbar-brand" href="/">
              <i class="fas fa-tasks me-2"></i>Task Editor
            </a>
          </div>
        </nav>

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
        <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/mdb-ui-kit/7.1.0/mdb.umd.min.js"></script>
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
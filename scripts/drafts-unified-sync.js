// Unified Drafts ↔ Today Sync System
// Syncs with vault via GitHub repository
//
// Setup:
// 1. In Drafts, create a new Action called "Today Sync"
// 2. Add a "Script" step and paste this entire code
// 3. Run the action and enter your GitHub token when prompted
// 4. The script will show a menu to choose sync operation

// ============ CONFIGURATION ============
const CONFIG = {
    // GitHub repository settings
    owner: 'jeffcovey',  // Your GitHub username
    repo: 'vault',       // Your vault repository name
    branch: 'main',
    githubToken: null,   // Will be set from credentials
    
    lastSyncKey: 'today_sync_last_timestamp' // Key for storing last sync time
};

// ============ CREDENTIAL SETUP ============
function setupCredentials() {
    const credential = Credential.create("GitHub Vault Sync", "Configure GitHub access token");
    credential.addPasswordField("githubToken", "GitHub Personal Access Token");
    
    if (!credential.authorize()) {
        return false;
    }
    
    CONFIG.githubToken = credential.getValue("githubToken");
    if (!CONFIG.githubToken || CONFIG.githubToken.trim() === '') {
        app.displayErrorMessage("GitHub Token is required");
        return false;
    }
    
    return true;
}

// ============ COMMON HELPER FUNCTIONS ============

// Get last sync timestamp from a special sync state draft
function getLastSyncTime() {
    // Look for a special draft that stores sync state
    const stateDrafts = Draft.query("# Today Sync State", "all", ["sync-state"], [], "modified", true, false);
    if (stateDrafts && stateDrafts.length > 0) {
        const stateDraft = stateDrafts[0];
        // Parse the timestamp from the draft content
        const match = stateDraft.content.match(/Last Sync: (.+)/);
        if (match) {
            const date = new Date(match[1]);
            if (!isNaN(date.getTime())) {
                return date;
            }
        }
    }
    return null;
}

// Update last sync timestamp in sync state draft
function updateLastSyncTime(timestamp) {
    const isoTime = timestamp || new Date().toISOString();
    
    // Look for existing sync state draft
    let stateDrafts = Draft.query("# Today Sync State", "all", ["sync-state"], [], "modified", true, false);
    let stateDraft;
    
    if (stateDrafts && stateDrafts.length > 0) {
        stateDraft = stateDrafts[0];
    } else {
        // Create new sync state draft
        stateDraft = Draft.create();
        stateDraft.addTag("sync-state");
        stateDraft.addTag("today-sync-meta");
    }
    
    // Update content with current timestamp
    stateDraft.content = `# Today Sync State\n\nThis draft stores metadata for the Today sync system.\n\nLast Sync: ${isoTime}\n\n---\n_Do not delete this draft - it's used for incremental sync tracking_`;
    stateDraft.update();
}

// Base64 encoding/decoding using Drafts built-in
function decodeBase64(str) {
    return Base64.decode(str);
}

function encodeBase64(str) {
    return Base64.encode(str);
}

// Extract metadata from draft content and auto-fix format if needed
function extractMetadata(content) {
    if (!content) return { metadata: {}, content: '', needsFormatFix: false };
    
    // Check for new markdown comment format (invisible in preview)
    // Format: [//]: # (key: value)
    const markdownCommentRegex = /\n\n\[\/\/\]: # \(sync-metadata-start\)\n([\s\S]*?)\[\/\/\]: # \(sync-metadata-end\)$/;
    let match = content.match(markdownCommentRegex);
    
    if (match) {
        const metadata = {};
        const metadataLines = match[1].split('\n');
        
        for (const line of metadataLines) {
            // Extract from [//]: # (key: value) format
            const lineMatch = line.match(/\[\/\/\]: # \(([^:]+): (.+)\)/);
            if (lineMatch) {
                const key = lineMatch[1].trim();
                // Unescape parentheses
                const value = lineMatch[2].replace(/\\([()])/g, '$1').trim();
                metadata[key] = value;
            }
        }
        
        const contentWithoutMetadata = content.replace(markdownCommentRegex, '');
        return { metadata, content: contentWithoutMetadata, needsFormatFix: false };
    }
    
    // Legacy format support for backwards compatibility
    const htmlCommentRegex = /\n\n<!-- sync-metadata[\s\S]*?-->$/;
    match = content.match(htmlCommentRegex);
    
    if (match) {
        const metadata = {};
        // Try to extract YAML-style metadata from HTML comment
        const yamlMatch = match[0].match(/---\n([\s\S]*?)\n---/);
        if (yamlMatch) {
            const lines = yamlMatch[1].split('\n');
            for (const line of lines) {
                const [key, ...valueParts] = line.split(':');
                if (key && valueParts.length > 0) {
                    metadata[key.trim()] = valueParts.join(':').trim();
                }
            }
        }
        
        const contentWithoutMetadata = content.replace(htmlCommentRegex, '');
        // Mark for format update
        return { metadata, content: contentWithoutMetadata, needsFormatFix: true };
    }
    
    return { metadata: {}, content: content, needsFormatFix: false };
}

// Update or add metadata to draft content (at bottom)
function updateMetadata(content, updates) {
    const { metadata: existingMeta, content: contentWithoutMeta } = extractMetadata(content);
    const newMetadata = { ...existingMeta, ...updates };
    
    // Use markdown link reference syntax which is invisible in preview
    // Format: [//]: # (metadata-key: value)
    let metadataSection = "\n\n";
    metadataSection += "[//]: # (sync-metadata-start)\n";
    
    for (const [key, value] of Object.entries(newMetadata)) {
        if (value !== null && value !== undefined && value !== '') {
            // Escape parentheses in the value
            const escapedValue = String(value).replace(/([()])/g, '\\$1');
            metadataSection += `[//]: # (${key}: ${escapedValue})\n`;
        }
    }
    
    metadataSection += "[//]: # (sync-metadata-end)";
    
    return contentWithoutMeta + metadataSection;
}

// Convert vault path to Drafts tags
function pathToTags(filePath) {
    // Remove 'vault/' prefix if present
    const cleanPath = filePath.replace(/^vault\//, '');
    const parts = cleanPath.split('/').filter(p => p);
    const tags = [];
    
    // Add vault base tag
    tags.push('today-sync');
    
    // Add folder tag based on first directory
    if (parts.length > 0) {
        const folder = parts[0].toLowerCase();
        if (!tags.includes(folder)) {
            tags.push(folder);
        }
    }
    
    return tags;
}

// Find draft by vault path
function findDraftByPath(path) {
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    for (const draft of syncDrafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path === path) {
            return draft;
        }
    }
    
    return null;
}

// Generate vault path from draft tags and content
function generateTodayPath(draft) {
    const content = draft.content || "";
    const lines = content.split('\n');
    
    // Get title from first line, removing markdown heading
    let title = lines[0].replace(/^#+\s*/, '').trim() || 'Untitled';
    
    // Create filename-safe title
    title = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50) || 'untitled';
    
    // Determine base path from tags (no 'vault/' prefix for GitHub)
    let basePath = 'notes';
    
    // Check for folder-specific tags
    const tags = draft.tags || [];
    if (tags.includes('tasks')) {
        basePath = 'tasks';
    } else if (tags.includes('projects')) {
        basePath = 'projects';
    } else if (tags.includes('plans')) {
        basePath = 'plans';
    } else if (tags.includes('daily') || tags.includes('journal')) {
        basePath = 'daily';
    } else if (tags.includes('reference')) {
        basePath = 'reference';
    }
    
    // Add timestamp for uniqueness
    const date = new Date().toISOString().split('T')[0];
    
    return `${basePath}/${date}-${title}.md`;
}


// ============ GITHUB API FUNCTIONS ============

// Fetch file list from GitHub repository
function fetchGitHubFileList() {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/git/trees/${CONFIG.branch}?recursive=1`,
            "method": "GET",
            "headers": {
                "Authorization": `Bearer ${CONFIG.githubToken}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            // Filter for .md files only, exclude hidden directories
            const files = data.tree
                .filter(item => {
                    // Must be a blob (file) and end with .md
                    if (item.type !== 'blob' || !item.path.endsWith('.md')) {
                        return false;
                    }
                    // Exclude paths that contain hidden directories (starting with .)
                    const pathParts = item.path.split('/');
                    for (const part of pathParts) {
                        if (part.startsWith('.')) {
                            return false;
                        }
                    }
                    return true;
                })
                .map(item => ({
                    path: item.path,
                    sha: item.sha,
                    size: item.size
                }));
            return files;
        } else {
            console.log(`Failed to fetch GitHub file list: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching GitHub file list: ${error}`);
        return null;
    }
}

// Fetch single file from GitHub
function fetchGitHubFile(path) {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(path)}?ref=${CONFIG.branch}`,
            "method": "GET",
            "headers": {
                "Authorization": `Bearer ${CONFIG.githubToken}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            // GitHub returns content as Base64 with newlines, strip them first
            const cleanBase64 = data.content.replace(/\n/g, '');
            const content = decodeBase64(cleanBase64);
            
            return {
                exists: true,
                content: content,
                sha: data.sha,
                lastModified: data.last_modified || new Date().toISOString()
            };
        } else if (response.statusCode === 404) {
            return { exists: false };
        } else {
            console.log(`Failed to fetch GitHub file ${path}: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching GitHub file ${path}: ${error}`);
        return null;
    }
}

// Upload file to GitHub
function uploadToGitHub(path, content, sha = null) {
    try {
        // Prepare the commit message
        const title = path.split('/').pop().replace('.md', '');
        const message = sha ? `Update ${title}` : `Create ${title}`;
        
        const requestData = {
            "message": message,
            "content": encodeBase64(content),
            "branch": CONFIG.branch
        };
        
        // Include SHA if updating existing file
        if (sha) {
            requestData.sha = sha;
        }
        
        const http = HTTP.create();
        const response = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${encodeURIComponent(path)}`,
            "method": "PUT",
            "headers": {
                "Authorization": `Bearer ${CONFIG.githubToken}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            "data": requestData,
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            return { success: true, sha: data.content.sha };
        } else {
            console.log(`Failed to upload to GitHub ${path}: ${response.statusCode} ${response.responseText}`);
            return { success: false, error: response.statusCode };
        }
    } catch (error) {
        console.log(`Error uploading to GitHub ${path}: ${error}`);
        return { success: false, error: error.message };
    }
}

// ============ SYNC FUNCTIONS ============

// Pull from GitHub to Drafts
function pullFromSource(incrementalSync = true) {
    const stats = { created: 0, updated: 0, deleted: 0, errors: 0 };
    
    console.log(`${incrementalSync ? "Incremental" : "Full"} pull from GitHub...`);
    
    // Fetch files from GitHub
    console.log("Fetching files from GitHub...");
    const sourceFiles = fetchGitHubFileList();
    
    if (!sourceFiles || sourceFiles.length === 0) {
        throw new Error("Failed to fetch files from GitHub");
    }
    
    console.log(`Found ${sourceFiles.length} files from GitHub`);
    
    for (const file of sourceFiles) {
        try {
            // Find existing draft
            let draft = findDraftByPath(file.path);
            
            // Skip if SHA hasn't changed (for incremental sync)
            if (incrementalSync && draft) {
                const { metadata } = extractMetadata(draft.content);
                if (metadata.today_sha === file.sha) {
                    continue; // File unchanged, skip
                }
            }
            
            // Fetch file content
            const fileData = fetchGitHubFile(file.path);
            
            if (!fileData || !fileData.exists) {
                stats.errors++;
                continue;
            }
            
            if (draft) {
                // Update existing draft
                draft.content = updateMetadata(fileData.content, {
                    today_path: file.path,
                    today_sha: fileData.sha || file.sha,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                draft.update();
                stats.updated++;
                console.log(`Updated: ${file.path}`);
                
            } else {
                // Create new draft
                draft = Draft.create();
                draft.content = updateMetadata(fileData.content, {
                    today_path: file.path,
                    today_sha: fileData.sha || file.sha,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                
                // Add appropriate tags
                const tags = pathToTags(file.path);
                for (const tag of tags) {
                    draft.addTag(tag);
                }
                
                draft.update();
                stats.created++;
                console.log(`Created: ${file.path}`);
            }
            
        } catch (error) {
            console.log(`Error processing ${file.path}: ${error}`);
            stats.errors++;
        }
    }
    
    updateLastSyncTime();
    return stats;
}

// Push from Drafts to GitHub
function pushToSource(onlyModified = true) {
    const stats = { created: 0, updated: 0, deleted: 0, errors: 0 };
    
    console.log(`${onlyModified ? "Modified" : "Full"} push to GitHub...`);
    
    // Get all sync-enabled drafts
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    console.log(`Found ${syncDrafts.length} sync-enabled drafts`);
    
    // Handle deletions first - check trashed drafts
    const trashedSyncDrafts = Draft.query("", "trash", ["today-sync"], [], "modified", false, false);
    if (trashedSyncDrafts.length > 0) {
        console.log(`Found ${trashedSyncDrafts.length} trashed sync drafts to handle`);
        // Just remove sync tags - we can't delete from vault via API
        for (const draft of trashedSyncDrafts) {
            draft.removeTag("today-sync");
            draft.update();
        }
    }
    
    // Upload new/modified drafts
    for (const draft of syncDrafts) {
        try {
            const { metadata, content, needsFormatFix } = extractMetadata(draft.content);
            
            if (onlyModified) {
                // Skip if not modified since last sync
                if (metadata.sync_status === "synced" && !needsFormatFix) {
                    continue;
                }
            }
            
            // Determine path from existing metadata or generate new one
            let todayPath = metadata.today_path;
            if (!todayPath) {
                todayPath = generateTodayPath(draft);
            }
            
            // Check if file exists to get its SHA
            const existingFile = fetchGitHubFile(todayPath);
            const sha = existingFile && existingFile.exists ? existingFile.sha : null;
            
            // Upload to GitHub
            const uploadResult = uploadToGitHub(todayPath, content, sha);
            
            if (uploadResult.success) {
                // Update draft with sync metadata
                draft.content = updateMetadata(content, {
                    today_path: todayPath,
                    today_sha: uploadResult.sha || metadata.today_sha,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                draft.update();
                
                stats.updated++;
                console.log(`Uploaded: ${todayPath}`);
            } else {
                console.log(`Failed to upload: ${todayPath}`);
                stats.errors++;
            }
            
        } catch (error) {
            console.log(`Error processing draft: ${error}`);
            stats.errors++;
        }
    }
    
    updateLastSyncTime();
    return stats;
}

// ============ MAIN MENU ============
if (!setupCredentials()) {
    context.fail("Credential setup failed");
}

const prompt = Prompt.create();
prompt.title = "Today Sync";
prompt.message = "GitHub Vault Sync";
prompt.addButton("📥 Pull from Vault", "pull");
prompt.addButton("📤 Push to Vault", "push");
prompt.addButton("🔄 Two-Way Sync", "sync");
prompt.addButton("🔄 Full Sync", "full");
prompt.addButton("📋 Status", "status");

if (prompt.show()) {
    try {
        const action = prompt.buttonPressed;
        
        if (action === "pull") {
            const stats = pullFromSource(true);
            app.displaySuccessMessage(`Pull complete!\n\n✅ Created: ${stats.created}\n📝 Updated: ${stats.updated}\n❌ Errors: ${stats.errors}`);
            
        } else if (action === "push") {
            const stats = pushToSource(true);
            app.displaySuccessMessage(`Push complete!\n\n📤 Uploaded: ${stats.updated}\n❌ Errors: ${stats.errors}`);
            
        } else if (action === "sync") {
            const pullStats = pullFromSource(true);
            const pushStats = pushToSource(true);
            app.displaySuccessMessage(`Two-way sync complete!\n\n📥 From vault: ${pullStats.created + pullStats.updated}\n📤 To vault: ${pushStats.updated}\n❌ Errors: ${pullStats.errors + pushStats.errors}`);
            
        } else if (action === "full") {
            const pullStats = pullFromSource(false);
            const pushStats = pushToSource(false);
            app.displaySuccessMessage(`Full sync complete!\n\n📥 Created: ${pullStats.created}\n📝 Updated: ${pullStats.updated}\n📤 Uploaded: ${pushStats.updated}\n❌ Errors: ${pullStats.errors + pushStats.errors}`);
            
        } else if (action === "status") {
            const lastSync = getLastSyncTime();
            const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
            const message = `Last Sync: ${lastSync ? lastSync.toLocaleString() : "Never"}\n\nSynced Drafts: ${syncDrafts.length}`;
            app.displayInfoMessage(message);
        }
    } catch (error) {
        app.displayErrorMessage(`Sync failed: ${error.message}`);
        console.log(error);
        context.fail();
    }
} else {
    context.cancel();
}
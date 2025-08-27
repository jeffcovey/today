// Unified Drafts ↔ Today Sync System
// Syncs with vault via droplet APIs
//
// Setup:
// 1. In Drafts, create a new Action called "Today Sync"
// 2. Add a "Script" step and paste this entire code
// 3. The script will show a menu to choose operation

// ============ CONFIGURATION ============
const CONFIG = {
    // Droplet API
    dropletUrl: 'https://today.jeffcovey.net',
    dropletApiKey: null, // Will be set from credentials
    
    lastSyncKey: 'today_sync_last_timestamp' // Key for storing last sync time
};

// ============ CREDENTIAL SETUP ============
function setupCredentials() {
    const credential = Credential.create("Today Sync Credentials", "Configure sync credentials");
    credential.addPasswordField("dropletApiKey", "Droplet API Key");
    
    if (!credential.authorize()) {
        return false;
    }
    
    CONFIG.dropletApiKey = credential.getValue("dropletApiKey");
    
    // API key is required
    if (!CONFIG.dropletApiKey || CONFIG.dropletApiKey.trim() === '') {
        app.displayErrorMessage("Droplet API Key is required");
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
    const parts = filePath.split('/').filter(p => p && p !== 'vault');
    const tags = [];
    
    // Add vault base tag
    tags.push('today-sync');
    
    // Add parent directories as tags
    for (let i = 0; i < parts.length - 1; i++) {
        const tag = parts.slice(0, i + 1).join('-').replace('.md', '').toLowerCase();
        if (tag && !tags.includes(tag)) {
            tags.push(tag);
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
    
    // Determine base path from tags
    let basePath = 'vault/notes';
    
    // Check for folder-specific tags
    const tags = draft.tags || [];
    if (tags.includes('projects')) {
        basePath = 'vault/projects';
    } else if (tags.includes('daily') || tags.includes('journal')) {
        basePath = 'vault/daily';
    } else if (tags.includes('reference')) {
        basePath = 'vault/reference';
    }
    
    // Add timestamp for uniqueness
    const date = new Date().toISOString().split('T')[0];
    
    return `${basePath}/${date}-${title}.md`;
}

// ============ DROPLET API FUNCTIONS ============

// Fetch file list from droplet vault API
function fetchDropletFileList() {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/api/vault/list`,
            "method": "GET",
            "headers": {
                "X-API-Key": CONFIG.dropletApiKey,
                "Accept": "application/json"
            },
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            return data.files || [];
        } else {
            console.log(`Failed to fetch file list: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching file list: ${error}`);
        return null;
    }
}

// Fetch file dates from droplet
function fetchDropletFileDates() {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/api/vault/file-dates`,
            "method": "GET",
            "headers": {
                "X-API-Key": CONFIG.dropletApiKey,
                "Accept": "application/json"
            },
            timeout: 30
        });
        
        if (response.success) {
            return JSON.parse(response.responseText);
        } else {
            console.log(`Failed to fetch file dates: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching file dates: ${error}`);
        return null;
    }
}

// Fetch single file from droplet
function fetchDropletFile(path) {
    try {
        // Remove 'vault/' prefix if present since the API endpoint already includes /vault/
        const cleanPath = path.replace(/^vault\//, '');
        
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/api/vault/file/${encodeURIComponent(cleanPath)}`,
            "method": "GET",
            "headers": {
                "X-API-Key": CONFIG.dropletApiKey,
                "Accept": "application/json"
            },
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            // Decode Base64 content if encoded
            const content = data.contentEncoding === 'base64' 
                ? decodeBase64(data.content) 
                : data.content;
            
            return {
                exists: true,
                content: content,
                sha: data.sha,
                lastModified: data.lastModified
            };
        } else if (response.statusCode === 404) {
            return { exists: false };
        } else {
            console.log(`Failed to fetch file ${path}: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching file ${path}: ${error}`);
        return null;
    }
}

// Upload file to droplet inbox
function uploadToDropletInbox(filename, content) {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/api/inbox/upload`,
            "method": "POST",
            "headers": {
                "X-API-Key": CONFIG.dropletApiKey,
                "Content-Type": "application/json"
            },
            "data": {
                "filename": filename,
                "content": content
            },
            timeout: 30
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            return { success: true, path: data.path };
        } else {
            console.log(`Failed to upload ${filename}: ${response.statusCode} ${response.error}`);
            return { success: false, error: response.statusCode };
        }
    } catch (error) {
        console.log(`Error uploading ${filename}: ${error}`);
        return { success: false, error: error.message };
    }
}

// ============ SYNC FUNCTIONS ============

// Pull from droplet to Drafts
function pullFromSource(incrementalSync = true) {
    const stats = { created: 0, updated: 0, deleted: 0, errors: 0 };
    
    console.log(incrementalSync ? "Starting incremental pull..." : "Starting full pull...");
    
    // Fetch files from droplet
    console.log("Fetching files from droplet...");
    const dropletFiles = fetchDropletFileList();
    
    if (!dropletFiles || dropletFiles.length === 0) {
        throw new Error("Failed to fetch files from droplet");
    }
    
    // Filter out inbox files
    let noteFiles = dropletFiles.filter(item => 
        !item.path.includes("/inbox/")
    );
    
    console.log(`Found ${noteFiles.length} files from droplet`);
    
    for (const file of noteFiles) {
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
            const fileData = fetchDropletFile(file.path);
            
            if (!fileData || !fileData.exists) {
                stats.errors++;
                continue;
            }
            
            if (draft) {
                // Update existing draft
                draft.content = updateMetadata(fileData.content, {
                    today_path: file.path,
                    today_sha: fileData.sha,
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
                    today_sha: fileData.sha,
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

// Push from Drafts to droplet
function pushToSource(onlyModified = true) {
    const stats = { created: 0, updated: 0, deleted: 0, errors: 0 };
    
    console.log(onlyModified ? "Starting push of modified drafts..." : "Starting full push...");
    
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
            
            // Determine filename from existing path or generate new one
            let todayPath = metadata.today_path;
            if (!todayPath) {
                todayPath = generateTodayPath(draft);
            }
            
            // Generate filename for inbox upload
            const pathParts = todayPath.split('/');
            const filename = pathParts[pathParts.length - 1];
            
            // Upload to inbox
            const uploadResult = uploadToDropletInbox(filename, content);
            
            if (uploadResult.success) {
                // Update draft with sync metadata
                draft.content = updateMetadata(content, {
                    today_path: todayPath,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                draft.update();
                
                stats.updated++;
                console.log(`Uploaded: ${filename}`);
            } else {
                console.log(`Failed to upload: ${filename}`);
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
prompt.message = "Choose sync operation:";
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
            const total = pullStats.created + pullStats.updated + pushStats.updated;
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
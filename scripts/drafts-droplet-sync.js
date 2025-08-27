// Droplet-First Drafts ↔ Today Sync System
// Uses your droplet as primary sync hub, with GitHub as fallback
//
// Setup:
// 1. In Drafts, create a new Action called "Today Droplet Sync"
// 2. Add a "Script" step and paste this entire code
// 3. Configure your API key when prompted

// ============ CONFIGURATION ============
const CONFIG = {
    // Droplet API (primary)
    dropletUrl: 'https://today.jeffcovey.net',
    dropletApiKey: null, // Will be set from credentials
    
    // GitHub (fallback)
    owner: 'OlderGay-Men',
    repo: 'today', 
    branch: 'main',
    githubToken: null, // Will be set from credentials
    
    // Sync state
    lastSyncKey: 'today_sync_last_timestamp'
};

// ============ CREDENTIAL SETUP ============
function setupCredentials() {
    const credential = Credential.create("Today Sync Credentials", "Configure sync credentials");
    credential.addPasswordField("dropletApiKey", "Droplet API Key");
    credential.addPasswordField("githubToken", "GitHub Token (fallback)");
    
    if (!credential.authorize()) {
        return false;
    }
    
    CONFIG.dropletApiKey = credential.getValue("dropletApiKey");
    CONFIG.githubToken = credential.getValue("githubToken");
    return true;
}

// ============ DROPLET API FUNCTIONS ============

// Fetch file list from droplet
function fetchDropletFileList() {
    const http = HTTP.create();
    const response = http.request({
        "url": `${CONFIG.dropletUrl}/api/vault/list`,
        "method": "GET",
        "headers": {
            "X-API-Key": CONFIG.dropletApiKey,
            "Accept": "application/json"
        }
    });
    
    if (!response.success) {
        console.log(`Failed to fetch droplet file list: ${response.statusCode}`);
        return null;
    }
    
    const data = JSON.parse(response.responseText);
    return data.files || [];
}

// Fetch specific file from droplet
function fetchDropletFile(path) {
    // Remove 'vault/' prefix if present for the API call
    const cleanPath = path.replace(/^vault\//, '');
    
    const http = HTTP.create();
    const response = http.request({
        "url": `${CONFIG.dropletUrl}/api/vault/file/${cleanPath}`,
        "method": "GET",
        "headers": {
            "X-API-Key": CONFIG.dropletApiKey,
            "Accept": "application/json"
        }
    });
    
    if (!response.success) {
        if (response.statusCode === 404) {
            return { exists: false };
        }
        console.log(`Failed to fetch ${path} from droplet: ${response.statusCode}`);
        return null;
    }
    
    const data = JSON.parse(response.responseText);
    return {
        exists: true,
        content: data.content,
        modified: data.modified
    };
}

// Fetch multiple files from droplet (batch)
function fetchDropletBatch(paths) {
    const http = HTTP.create();
    const response = http.request({
        "url": `${CONFIG.dropletUrl}/api/vault/batch`,
        "method": "POST",
        "data": { paths: paths },
        "headers": {
            "X-API-Key": CONFIG.dropletApiKey,
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
    });
    
    if (!response.success) {
        console.log(`Failed to fetch batch from droplet: ${response.statusCode}`);
        return null;
    }
    
    const data = JSON.parse(response.responseText);
    return data.results || {};
}

// Upload file to droplet inbox
function uploadToDroplet(filename, content) {
    const http = HTTP.create();
    const response = http.request({
        "url": `${CONFIG.dropletUrl}/api/inbox/upload`,
        "method": "POST",
        "data": {
            filename: filename,
            content: content
        },
        "headers": {
            "X-API-Key": CONFIG.dropletApiKey,
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
    });
    
    if (response.success) {
        const result = JSON.parse(response.responseText);
        return { success: true, path: result.path };
    } else {
        console.log(`Failed to upload to droplet: ${response.statusCode}`);
        return { success: false, error: response.statusCode };
    }
}

// ============ GITHUB FALLBACK FUNCTIONS ============

// Fetch file from GitHub
function fetchGitHubFile(path) {
    const http = HTTP.create();
    const response = http.request({
        "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`,
        "method": "GET",
        "headers": {
            "Accept": "application/vnd.github.v3+json",
            "Authorization": `Bearer ${CONFIG.githubToken}`,
            "User-Agent": "Drafts-Today-Sync"
        }
    });
    
    if (!response.success) {
        if (response.statusCode === 404) {
            return { exists: false };
        }
        console.log(`Failed to fetch ${path} from GitHub: ${response.statusCode}`);
        return null;
    }
    
    const data = JSON.parse(response.responseText);
    const cleanBase64 = data.content.replace(/\n/g, '');
    const content = Base64.decode(cleanBase64);
    
    return {
        exists: true,
        content: content,
        sha: data.sha
    };
}

// Upload to GitHub
function uploadToGitHub(path, content, sha = null) {
    const requestBody = {
        "message": sha ? `Update ${path} from Drafts` : `Create ${path} from Drafts`,
        "content": Base64.encode(content),
        "branch": CONFIG.branch
    };
    
    if (sha) {
        requestBody.sha = sha;
    }
    
    const http = HTTP.create();
    const response = http.request({
        "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`,
        "method": "PUT",
        "data": requestBody,
        "headers": {
            "Authorization": `Bearer ${CONFIG.githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Drafts-Today-Sync"
        }
    });
    
    return response.success;
}

// ============ SYNC STATE FUNCTIONS ============

// Get last sync timestamp
function getLastSyncTime() {
    const stateDrafts = Draft.query("# Today Sync State", "all", ["sync-state"], [], "modified", true, false);
    if (stateDrafts && stateDrafts.length > 0) {
        const stateDraft = stateDrafts[0];
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

// Update last sync timestamp
function updateLastSyncTime(timestamp) {
    const isoTime = timestamp || new Date().toISOString();
    
    let stateDrafts = Draft.query("# Today Sync State", "all", ["sync-state"], [], "modified", true, false);
    let stateDraft;
    
    if (stateDrafts && stateDrafts.length > 0) {
        stateDraft = stateDrafts[0];
    } else {
        stateDraft = Draft.create();
        stateDraft.addTag("sync-state");
        stateDraft.addTag("today-sync-meta");
    }
    
    stateDraft.content = `# Today Sync State\n\nThis draft stores metadata for the Today sync system.\n\nLast Sync: ${isoTime}\n\nPrimary: Droplet (${CONFIG.dropletUrl})\nFallback: GitHub\n\n---\n_Do not delete this draft - it's used for incremental sync tracking_`;
    stateDraft.update();
}

// ============ METADATA FUNCTIONS ============

// Extract metadata from draft content
function extractMetadata(content) {
    if (!content) return { metadata: {}, content: '' };
    
    // Check for markdown comment format
    const markdownCommentRegex = /\n\n\[\/\/\]: # \(sync-metadata-start\)\n([\s\S]*?)\[\/\/\]: # \(sync-metadata-end\)$/;
    const match = content.match(markdownCommentRegex);
    
    if (match) {
        const metadata = {};
        const metadataLines = match[1].split('\n');
        
        for (const line of metadataLines) {
            const lineMatch = line.match(/\[\/\/\]: # \(([^:]+): (.+)\)/);
            if (lineMatch) {
                const key = lineMatch[1].trim();
                const value = lineMatch[2].replace(/\\([()])/g, '$1').trim();
                metadata[key] = value;
            }
        }
        
        const contentWithoutMetadata = content.replace(markdownCommentRegex, '');
        return { metadata, content: contentWithoutMetadata };
    }
    
    return { metadata: {}, content: content };
}

// Update metadata in draft
function updateMetadata(content, updates) {
    const { metadata: existingMeta, content: contentWithoutMeta } = extractMetadata(content);
    const newMetadata = { ...existingMeta, ...updates };
    
    let metadataSection = "\n\n";
    metadataSection += "[//]: # (sync-metadata-start)\n";
    for (const [key, value] of Object.entries(newMetadata)) {
        if (value !== null && value !== undefined) {
            const escapedValue = value.replace(/[()]/g, '\\$&');
            metadataSection += `[//]: # (${key}: ${escapedValue})\n`;
        }
    }
    metadataSection += "[//]: # (sync-metadata-end)";
    
    return contentWithoutMeta.trim() + metadataSection;
}

// Convert path to tags
function pathToTags(path) {
    const tags = ["today-sync"];
    
    if (path.startsWith("vault/")) {
        const pathWithoutVault = path.substring(6);
        const parts = pathWithoutVault.split('/');
        
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            
            if (i === 0) {
                tags.push(part);
            }
            
            if (i === 1) {
                tags.push(`${parts[0]}/${part}`);
            }
        }
    }
    
    return tags;
}

// Find draft by path
function findDraftByPath(todayPath) {
    const drafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    for (const draft of drafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path === todayPath) {
            return draft;
        }
    }
    
    return null;
}

// ============ SYNC OPERATIONS ============

// Pull from droplet (with GitHub fallback)
function pullFromDroplet() {
    console.log("Starting pull from droplet...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, errors: 0, fallback: 0 };
    
    // Try to get file list from droplet
    let fileList = fetchDropletFileList();
    let usingDroplet = true;
    
    if (!fileList) {
        console.log("Droplet unavailable, falling back to GitHub...");
        usingDroplet = false;
        stats.fallback++;
        
        // Fallback to GitHub
        const http = HTTP.create();
        const treeResponse = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/git/trees/${CONFIG.branch}?recursive=1`,
            "method": "GET",
            "headers": {
                "Authorization": `Bearer ${CONFIG.githubToken}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Drafts-Today-Sync"
            }
        });
        
        if (!treeResponse.success) {
            throw new Error(`Failed to fetch from both droplet and GitHub`);
        }
        
        const tree = JSON.parse(treeResponse.responseText);
        fileList = tree.tree
            .filter(item => item.type === "blob" && item.path.startsWith("vault/") && item.path.endsWith(".md"))
            .map(item => ({ path: item.path, sha: item.sha }));
    }
    
    // Filter out inbox files
    fileList = fileList.filter(f => !f.path.includes("/inbox/"));
    console.log(`Found ${fileList.length} files to sync`);
    
    // Process files
    for (const file of fileList) {
        try {
            // Check if draft exists
            let draft = findDraftByPath(file.path);
            
            // Fetch content
            let fileData;
            if (usingDroplet) {
                fileData = fetchDropletFile(file.path);
            } else {
                fileData = fetchGitHubFile(file.path);
            }
            
            if (!fileData || !fileData.exists) {
                stats.errors++;
                continue;
            }
            
            if (draft) {
                // Update existing draft
                const { metadata } = extractMetadata(draft.content);
                
                // Check if content changed
                const { content: currentContent } = extractMetadata(draft.content);
                if (currentContent.trim() === fileData.content.trim()) {
                    stats.skipped++;
                    continue;
                }
                
                draft.content = updateMetadata(fileData.content, {
                    today_path: file.path,
                    last_sync: new Date().toISOString(),
                    sync_source: usingDroplet ? "droplet" : "github"
                });
                draft.update();
                stats.updated++;
                console.log(`Updated: ${file.path}`);
            } else {
                // Create new draft
                draft = Draft.create();
                draft.content = updateMetadata(fileData.content, {
                    today_path: file.path,
                    last_sync: new Date().toISOString(),
                    sync_source: usingDroplet ? "droplet" : "github"
                });
                
                // Add tags
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
    
    const elapsed = Date.now() - startTime;
    console.log(`Pull completed in ${elapsed}ms`);
    
    updateLastSyncTime();
    return stats;
}

// Push to droplet (with GitHub fallback)
function pushToDroplet() {
    console.log("Starting push to droplet...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, errors: 0, fallback: 0 };
    
    // Get drafts with today-sync tag
    const drafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    console.log(`Found ${drafts.length} drafts to sync`);
    
    // Check if droplet is available
    const testResponse = HTTP.create().request({
        "url": `${CONFIG.dropletUrl}/api/health`,
        "method": "GET",
        "headers": { "Accept": "application/json" }
    });
    
    const dropletAvailable = testResponse.success;
    
    for (const draft of drafts) {
        try {
            // Skip empty drafts
            if (!draft.content || draft.content.trim().length === 0) {
                stats.skipped++;
                continue;
            }
            
            const { metadata, content: rawContent } = extractMetadata(draft.content);
            
            // Skip drafts without a path
            if (!metadata.today_path) {
                stats.skipped++;
                continue;
            }
            
            // Generate filename for inbox upload
            const pathParts = metadata.today_path.split('/');
            const filename = pathParts[pathParts.length - 1];
            
            // Try droplet first
            if (dropletAvailable) {
                const result = uploadToDroplet(filename, rawContent);
                
                if (result.success) {
                    // Update metadata
                    draft.content = updateMetadata(draft.content, {
                        last_sync: new Date().toISOString(),
                        sync_status: "synced",
                        sync_source: "droplet"
                    });
                    draft.update();
                    stats.updated++;
                    console.log(`Uploaded to droplet: ${filename}`);
                    continue;
                }
            }
            
            // Fallback to GitHub
            if (CONFIG.githubToken) {
                console.log(`Falling back to GitHub for ${metadata.today_path}`);
                stats.fallback++;
                
                // Check if file exists on GitHub
                const githubFile = fetchGitHubFile(metadata.today_path);
                const success = uploadToGitHub(
                    metadata.today_path,
                    rawContent,
                    githubFile && githubFile.exists ? githubFile.sha : null
                );
                
                if (success) {
                    draft.content = updateMetadata(draft.content, {
                        last_sync: new Date().toISOString(),
                        sync_status: "synced",
                        sync_source: "github"
                    });
                    draft.update();
                    
                    if (githubFile && githubFile.exists) {
                        stats.updated++;
                        console.log(`Updated on GitHub: ${metadata.today_path}`);
                    } else {
                        stats.created++;
                        console.log(`Created on GitHub: ${metadata.today_path}`);
                    }
                } else {
                    stats.errors++;
                }
            } else {
                console.log(`No fallback available for ${metadata.today_path}`);
                stats.errors++;
            }
        } catch (error) {
            console.log(`Error processing draft: ${error}`);
            stats.errors++;
        }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Push completed in ${elapsed}ms`);
    
    updateLastSyncTime();
    return stats;
}

// Quick sync (both directions)
function quickSync() {
    console.log("Starting quick sync...");
    
    // First pull
    const pullStats = pullFromDroplet();
    
    // Then push
    const pushStats = pushToDroplet();
    
    // Log summary
    const totalChanges = pullStats.created + pullStats.updated + 
                        pushStats.created + pushStats.updated;
    
    if (totalChanges > 0) {
        console.log(`\nSync completed with changes:`);
        if (pullStats.created > 0) console.log(`  - Created ${pullStats.created} drafts`);
        if (pullStats.updated > 0) console.log(`  - Updated ${pullStats.updated} drafts`);
        if (pushStats.created > 0) console.log(`  - Uploaded ${pushStats.created} new files`);
        if (pushStats.updated > 0) console.log(`  - Updated ${pushStats.updated} files`);
        if (pullStats.fallback > 0) console.log(`  - Used GitHub fallback for pull`);
        if (pushStats.fallback > 0) console.log(`  - Used fallback for ${pushStats.fallback} uploads`);
    } else {
        console.log(`\nSync completed: Everything is already up to date`);
    }
    
    return { pull: pullStats, push: pushStats };
}

// ============ MAIN MENU ============

function main() {
    // Setup credentials
    if (!setupCredentials()) {
        app.displayErrorMessage("Credentials required");
        context.fail("No credentials");
        return;
    }
    
    // Create menu
    const prompt = Prompt.create();
    prompt.title = "Today Droplet Sync";
    prompt.message = "Choose an operation:";
    
    prompt.addButton("🔄 Quick Sync", "sync");
    prompt.addButton("⬇️ Pull from Droplet", "pull");
    prompt.addButton("⬆️ Push to Droplet", "push");
    prompt.addButton("Cancel");
    
    if (!prompt.show()) {
        context.cancel("User cancelled");
        return;
    }
    
    try {
        let result;
        let message;
        
        switch (prompt.buttonPressed) {
            case "sync":
                result = quickSync();
                message = `Sync Complete\n\nPull: ${result.pull.created} new, ${result.pull.updated} updated\nPush: ${result.push.created} new, ${result.push.updated} updated`;
                if (result.pull.fallback > 0 || result.push.fallback > 0) {
                    message += `\n\nFallback used: ${result.pull.fallback + result.push.fallback} operations`;
                }
                app.displaySuccessMessage(message);
                break;
                
            case "pull":
                result = pullFromDroplet();
                message = `Pull Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}`;
                if (result.fallback > 0) {
                    message += `\n\nUsed GitHub fallback`;
                }
                app.displaySuccessMessage(message);
                break;
                
            case "push":
                result = pushToDroplet();
                message = `Push Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}`;
                if (result.fallback > 0) {
                    message += `\n\nFallback used for ${result.fallback} files`;
                }
                app.displaySuccessMessage(message);
                break;
                
            default:
                context.cancel("Operation cancelled");
                return;
        }
        
        console.log(message);
        
    } catch (error) {
        app.displayErrorMessage(`Operation failed: ${error.message}`);
        console.log(error);
        context.fail(error.message);
    }
}

// Run
main();
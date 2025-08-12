// Drafts Action: Sync to Today
// Pushes modified drafts back to Today app
// 
// Setup:
// 1. Use same GitHub token as sync-today-to-drafts.js
// 2. In Drafts, create a new Action called "Sync to Today"
// 3. Add a "Script" step and paste this code

// ============ CONFIGURATION ============
const config = {
    owner: 'OlderGay-Men',
    repo: 'today',
    branch: 'main',
    token: null // Will be set from credentials
};

// Use Drafts Credential for secure token storage
const credential = Credential.create("GitHub Token", "Enter your GitHub Personal Access Token");
credential.addPasswordField("token", "Token");
if (!credential.authorize()) {
    context.fail("Today credentials required");
}
config.token = credential.getValue("token");

// ============ HELPER FUNCTIONS ============

// Extract metadata from draft content
function extractMetadata(content) {
    const metadataRegex = /^---\n([\s\S]*?)\n---\n/;
    const match = content.match(metadataRegex);
    
    if (!match) return { metadata: {}, content: content };
    
    const metadata = {};
    const metadataText = match[1];
    const lines = metadataText.split('\n');
    
    for (const line of lines) {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length > 0) {
            metadata[key.trim()] = valueParts.join(':').trim();
        }
    }
    
    const contentWithoutMetadata = content.replace(metadataRegex, '');
    return { metadata, content: contentWithoutMetadata };
}

// Update metadata in content
function updateMetadata(content, updates) {
    const { metadata, content: rawContent } = extractMetadata(content);
    const newMetadata = { ...metadata, ...updates };
    
    const metadataText = Object.entries(newMetadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    
    return `---\n${metadataText}\n---\n\n${rawContent}`;
}

// Generate path from tags if no today_path exists
function generatePathFromTags(draft) {
    const tags = draft.tags;
    
    // Look for the most specific notes/* tag
    let bestTag = null;
    for (const tag of tags) {
        if (tag.startsWith("notes/") && (!bestTag || tag.length > bestTag.length)) {
            bestTag = tag;
        }
    }
    
    if (!bestTag) {
        // Default to daily notes
        bestTag = "notes/daily";
    }
    
    // Generate filename from title or date
    // First, strip metadata if present
    const contentWithoutMeta = draft.content.replace(/^---[\s\S]*?---\n*/m, '');
    const firstLine = contentWithoutMeta.split('\n')[0];
    const title = firstLine.replace(/^#\s*/, '').trim();
    const date = draft.createdAt.toISOString().split('T')[0];
    
    let filename;
    if (title && title.length > 0) {
        // Sanitize title for filename
        filename = title.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 50);
    } else {
        filename = "untitled";
    }
    
    return `${bestTag}/${date}-${filename}.md`;
}

// Decode base64 content from GitHub
function decodeBase64(str) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    
    str = str.replace(/[^A-Za-z0-9\+\/]/g, '');
    
    for (let i = 0; i < str.length; i += 4) {
        const encoded1 = chars.indexOf(str.charAt(i));
        const encoded2 = chars.indexOf(str.charAt(i + 1));
        const encoded3 = chars.indexOf(str.charAt(i + 2));
        const encoded4 = chars.indexOf(str.charAt(i + 3));
        
        const bits = (encoded1 << 18) | (encoded2 << 12) | (encoded3 << 6) | encoded4;
        
        output += String.fromCharCode((bits >> 16) & 0xFF);
        if (encoded3 !== 64) output += String.fromCharCode((bits >> 8) & 0xFF);
        if (encoded4 !== 64) output += String.fromCharCode(bits & 0xFF);
    }
    
    return output;
}

// Encode content to base64 for GitHub API
function encodeBase64(str) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
    
    while (i < str.length) {
        const a = str.charCodeAt(i++);
        const b = i < str.length ? str.charCodeAt(i++) : 0;
        const c = i < str.length ? str.charCodeAt(i++) : 0;
        
        const bitmap = (a << 16) | (b << 8) | c;
        
        result += chars.charAt((bitmap >> 18) & 63);
        result += chars.charAt((bitmap >> 12) & 63);
        result += i - 2 < str.length ? chars.charAt((bitmap >> 6) & 63) : '=';
        result += i - 1 < str.length ? chars.charAt(bitmap & 63) : '=';
    }
    
    return result;
}

// Check if file exists on Today server and get SHA
function getTodayFile(path) {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`;
    
    const request = {
        "url": url,
        "method": "GET",
        "headers": {
            "Authorization": `token ${config.token}`,
            "Accept": "application/vnd.github.v3+json"
        }
    };
    
    const http = HTTP.create();
    const response = http.request(request);
    
    if (response.success) {
        return JSON.parse(response.responseText);
    } else if (response.statusCode === 404) {
        return null; // File doesn't exist
    } else {
        throw new Error(`Failed to check file: ${response.statusCode}`);
    }
}

// Upload or update file on Today server
function uploadToToday(path, content, sha = null) {
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
    
    const requestBody = {
        "message": sha ? `Update ${path} from Drafts` : `Create ${path} from Drafts`,
        "content": encodeBase64(content),
        "branch": config.branch
    };
    
    if (sha) {
        requestBody.sha = sha;
    }
    
    const request = {
        "url": url,
        "method": "PUT",
        "data": requestBody,
        "headers": {
            "Authorization": `token ${config.token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json"
        }
    };
    
    const http = HTTP.create();
    const response = http.request(request);
    
    if (response.success) {
        const result = JSON.parse(response.responseText);
        return result.content.sha;
    } else {
        throw new Error(`Failed to upload: ${response.statusCode} - ${response.responseText}`);
    }
}

// Special handling for tasks.md
function mergeTasksContent(localContent, remoteContent) {
    // Extract tasks from both versions
    const localTasks = localContent.split('\n').filter(line => line.match(/^-\s*\[[ x]\]/));
    const remoteTasks = remoteContent.split('\n').filter(line => line.match(/^-\s*\[[ x]\]/));
    
    // Combine unique tasks
    const allTasks = new Set([...localTasks, ...remoteTasks]);
    
    // Separate active and completed
    const activeTasks = Array.from(allTasks).filter(task => task.includes('- [ ]'));
    const completedTasks = Array.from(allTasks).filter(task => task.includes('- [x]'));
    
    // Rebuild content
    let merged = activeTasks.join('\n');
    
    if (completedTasks.length > 0) {
        merged += '\n\n# Archive\n\n';
        const today = new Date().toISOString().split('T')[0];
        merged += `## ${today}\n`;
        merged += completedTasks.join('\n');
    }
    
    return merged;
}

// ============ MAIN SYNC FUNCTION ============

function syncToToday() {
    const stats = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0
    };
    
    console.log("Starting sync to Today...");
    
    try {
        // Query all drafts with today-sync tag
        const drafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
        
        console.log(`Found ${drafts.length} drafts with today-sync tag`);
        
        // Debug: Show first draft's content snippet
        if (drafts.length > 0) {
            console.log(`First draft preview: ${drafts[0].content.substring(0, 50)}...`);
        }
        
        for (const draft of drafts) {
            try {
                // Skip if draft is empty
                if (!draft.content || draft.content.trim().length === 0) {
                    console.log("  Skipping empty draft");
                    stats.skipped++;
                    continue;
                }
                
                // Extract metadata
                const { metadata, content: rawContent } = extractMetadata(draft.content);
                
                // Determine path - prefer metadata, fall back to generation
                let todayPath = metadata.today_path;
                if (!todayPath) {
                    // Generate path from tags
                    todayPath = generatePathFromTags(draft);
                    console.log(`  No metadata path, generated: ${todayPath}`);
                } else {
                    console.log(`  Using metadata path: ${todayPath}`);
                }
                
                console.log(`Processing: ${todayPath}`);
                
                // Check if file exists on Today server
                const existingFile = getTodayFile(todayPath);
                
                // Prepare content (without metadata for GitHub)
                let contentToUpload = rawContent.trim();
                
                // Special handling for specific files
                if (todayPath.endsWith('/tasks.md') && existingFile) {
                    // Merge tasks instead of overwriting
                    const remoteContent = decodeBase64(existingFile.content);
                    contentToUpload = mergeTasksContent(contentToUpload, remoteContent);
                }
                
                if (existingFile) {
                    // Check if content has changed
                    const remoteContent = decodeBase64(existingFile.content);
                    if (remoteContent.trim() === contentToUpload.trim()) {
                        console.log("  No changes to sync");
                        stats.skipped++;
                        continue;
                    }
                    
                    // Update existing file
                    const newSha = uploadToToday(todayPath, contentToUpload, existingFile.sha);
                    
                    // Update draft metadata
                    draft.content = updateMetadata(draft.content, {
                        today_path: todayPath,
                        today_sha: newSha,
                        last_sync: new Date().toISOString(),
                        sync_status: "synced"
                    });
                    draft.update();
                    
                    console.log("  Updated on Today");
                    stats.updated++;
                    
                } else {
                    // Create new file
                    const newSha = uploadToToday(todayPath, contentToUpload);
                    
                    // Update draft metadata
                    draft.content = updateMetadata(draft.content, {
                        today_path: todayPath,
                        today_sha: newSha,
                        last_sync: new Date().toISOString(),
                        sync_status: "synced"
                    });
                    draft.update();
                    
                    console.log("  Created on Today");
                    stats.created++;
                }
                
            } catch (error) {
                console.log(`  Error processing draft: ${error.message}`);
                console.log(`  Stack: ${error.stack}`);
                stats.errors++;
                stats.lastError = error.message; // Store for debug output
                
                // Mark draft as having sync error
                draft.addTag("sync-error");
                draft.update();
            }
        }
        
        // Create sync summary with debug info
        let debugInfo = "";
        if (stats.errors > 0 && drafts.length > 0) {
            debugInfo = `\n\n## Debug Info\n\n`;
            debugInfo += `First draft content (50 chars):\n\`\`\`\n${drafts[0].content.substring(0, 100)}\n\`\`\`\n\n`;
            
            // Check metadata extraction on first draft
            const { metadata, content } = extractMetadata(drafts[0].content);
            debugInfo += `Extracted metadata:\n`;
            debugInfo += `- today_path: ${metadata.today_path || "NOT FOUND"}\n`;
            debugInfo += `- today_sha: ${metadata.today_sha ? "present" : "missing"}\n`;
            debugInfo += `- sync_status: ${metadata.sync_status || "NOT FOUND"}\n\n`;
            debugInfo += `Content after metadata removal (50 chars):\n\`\`\`\n${content.substring(0, 50)}\n\`\`\`\n\n`;
            
            if (stats.lastError) {
                debugInfo += `Last error message: ${stats.lastError}\n`;
            }
        }
        
        const summary = `Today Push Complete\n\n` +
            `✅ Created: ${stats.created} files\n` +
            `🔄 Updated: ${stats.updated} files\n` +
            `⏭️ Skipped: ${stats.skipped} files\n` +
            `❌ Errors: ${stats.errors}\n\n` +
            `Total drafts processed: ${drafts.length}` +
            debugInfo;
        
        // Update sync status draft
        let statusDraft = Draft.query("title:Today Sync Status", "all", ["today-sync-status"], [], "modified", true, false)[0];
        if (!statusDraft) {
            statusDraft = Draft.create();
            statusDraft.addTag("today-sync-status");
        }
        
        statusDraft.content = `# Today Sync Status\n\n${summary}\n\nLast push: ${new Date().toLocaleString()}`;
        statusDraft.update();
        
        // Show success message
        app.displaySuccessMessage(`Push complete: ${stats.created} new, ${stats.updated} updated`);
        
        // Load the status draft to show results
        editor.load(statusDraft);
        
    } catch (error) {
        app.displayErrorMessage(`Sync failed: ${error.message}`);
        console.log(error);
        context.fail(error.message);
    }
}

// Run the sync
syncToToday();
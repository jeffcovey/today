// Unified Drafts ↔ Today Sync System
// Combines all sync functionality in one script with a menu
//
// Setup:
// 1. In Drafts, create a new Action called "Today Sync"
// 2. Add a "Script" step and paste this entire code
// 3. The script will show a menu to choose operation

// ============ CONFIGURATION ============
const CONFIG = {
    owner: 'OlderGay-Men',
    repo: 'today',
    branch: 'main',
    token: null // Will be set from credentials
};

// ============ CREDENTIAL SETUP ============
function setupCredentials() {
    const credential = Credential.create("Today GitHub Token", "Enter your GitHub Personal Access Token:");
    credential.addPasswordField("token", "Personal Access Token");
    
    if (!credential.authorize()) {
        return false;
    }
    
    CONFIG.token = credential.getValue("token");
    return true;
}

// ============ COMMON HELPER FUNCTIONS ============

// Base64 encoding/decoding using Drafts built-in
function decodeBase64(str) {
    return Base64.decode(str);
}

function encodeBase64(str) {
    return Base64.encode(str);
}

// Extract metadata from draft content (supports top and bottom placement)
function extractMetadata(content) {
    if (!content) return { metadata: {}, content: '' };
    
    // Check for metadata at the bottom with clear separator
    const bottomMetadataRegex = /\n\n<!-- sync-metadata -->\n---\n([\s\S]*?)\n---$/;
    let match = content.match(bottomMetadataRegex);
    
    if (match) {
        const metadata = {};
        const metadataText = match[1];
        const lines = metadataText.split('\n');
        
        for (const line of lines) {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
                metadata[key.trim()] = valueParts.join(':').trim();
            }
        }
        
        const contentWithoutMetadata = content.replace(bottomMetadataRegex, '');
        return { metadata, content: contentWithoutMetadata };
    }
    
    // Legacy: Check for metadata at top
    const topMetadataRegex = /^---\n([\s\S]*?)\n---\n/;
    match = content.match(topMetadataRegex);
    
    if (match) {
        const metadata = {};
        const metadataText = match[1];
        const lines = metadataText.split('\n');
        
        for (const line of lines) {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
                metadata[key.trim()] = valueParts.join(':').trim();
            }
        }
        
        const contentWithoutMetadata = content.replace(topMetadataRegex, '');
        return { metadata, content: contentWithoutMetadata };
    }
    
    return { metadata: {}, content: content };
}

// Update or add metadata to draft content (at bottom)
function updateMetadata(content, updates) {
    const { metadata: existingMeta, content: contentWithoutMeta } = extractMetadata(content);
    const newMetadata = { ...existingMeta, ...updates };
    
    let metadataSection = "\n\n<!-- sync-metadata -->\n---\n";
    for (const [key, value] of Object.entries(newMetadata)) {
        if (value !== null && value !== undefined) {
            metadataSection += `${key}: ${value}\n`;
        }
    }
    metadataSection += "---";
    
    return contentWithoutMeta.trim() + metadataSection;
}

// Convert GitHub path to Drafts tags
function pathToTags(path) {
    const tags = ["today-sync"];
    
    // Add hierarchical tags for the path
    if (path.startsWith("notes/") || path.startsWith("projects/")) {
        tags.push("notes"); // Always add base 'notes' tag
        
        const parts = path.split('/');
        let tagPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
            tagPath = tagPath ? `${tagPath}/${parts[i]}` : parts[i];
            tags.push(tagPath);
        }
    }
    
    return tags;
}

// Find draft by GitHub path
function findDraftByPath(todayPath) {
    // Don't use cache - it causes issues with newly created drafts
    const drafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    for (const draft of drafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path === todayPath) {
            return draft;
        }
    }
    
    return null;
}

// Generate GitHub path from draft tags and content
function generatePathFromTags(draft) {
    const tags = draft.tags;
    
    // Find the most specific tag that looks like a path
    let bestTag = null;
    for (const tag of tags) {
        if (tag.startsWith("notes/") || tag.startsWith("projects/")) {
            if (!bestTag || tag.length > bestTag.length) {
                bestTag = tag;
            }
        }
    }
    
    if (!bestTag) {
        bestTag = "notes/daily";
    }
    
    // Generate filename from title or date
    const contentWithoutMeta = (draft.content || '').replace(/^---[\s\S]*?---\n*/m, '');
    const firstLine = contentWithoutMeta.split('\n')[0];
    const title = firstLine.replace(/^#\s*/, '').trim();
    const date = draft.createdAt.toISOString().split('T')[0];
    
    let filename;
    if (title && title.length > 0) {
        filename = title.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 50);
    } else {
        filename = "untitled";
    }
    
    return `${bestTag}/${date}-${filename}.md`;
}

// Fetch file from GitHub
function fetchGitHubFile(path) {
    const http = HTTP.create();
    const response = http.request({
        "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`,
        "method": "GET",
        "headers": {
            "Accept": "application/vnd.github.v3+json",
            "Authorization": `Bearer ${CONFIG.token}`,
            "User-Agent": "Drafts-Today-Sync"
        }
    });
    
    if (!response.success) {
        if (response.statusCode === 404) {
            return { exists: false };
        }
        console.log(`Failed to fetch ${path}: ${response.statusCode} ${response.error}`);
        return null;
    }
    
    const data = JSON.parse(response.responseText);
    // GitHub returns base64 with newlines, need to clean it
    const cleanBase64 = data.content.replace(/\n/g, '');
    const content = decodeBase64(cleanBase64);
    
    return {
        exists: true,
        content: content,
        sha: data.sha
    };
}

// ============ SYNC OPERATIONS ============

// Pull from GitHub to Drafts
function pullFromGitHub() {
    console.log("Starting pull from GitHub...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
    
    // Fetch repository tree
    const http = HTTP.create();
    const treeResponse = http.request({
        "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/git/trees/${CONFIG.branch}?recursive=1`,
        "method": "GET",
        "headers": {
            "Authorization": `Bearer ${CONFIG.token}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Drafts-Today-Sync"
        }
    });
    
    if (!treeResponse.success) {
        throw new Error(`Failed to fetch repository: ${treeResponse.statusCode}`);
    }
    
    const tree = JSON.parse(treeResponse.responseText);
    
    // Filter for notes and projects markdown files
    const noteFiles = tree.tree.filter(item => 
        item.type === "blob" && 
        (item.path.startsWith("notes/") || item.path.startsWith("projects/")) && 
        item.path.endsWith(".md") &&
        !item.path.includes("/inbox/") // Skip inbox files
    );
    
    console.log(`Found ${noteFiles.length} files to sync`);
    
    // Build set of paths that exist on GitHub and map of SHAs
    const githubPaths = new Set(noteFiles.map(f => f.path));
    const githubSHAs = {};
    noteFiles.forEach(f => { githubSHAs[f.path] = f.sha; });
    
    // Process each file
    for (const file of noteFiles) {
        try {
            // First check if draft exists and if it needs updating
            let draft = findDraftByPath(file.path);
            
            if (draft) {
                // Check if update needed by comparing SHA
                const { metadata } = extractMetadata(draft.content);
                if (metadata.today_sha === githubSHAs[file.path]) {
                    // SHA matches, no need to fetch content
                    stats.skipped++;
                    continue;
                }
            }
            
            // Only fetch content if we need to create or update
            const fileData = fetchGitHubFile(file.path);
            if (!fileData || !fileData.exists) {
                stats.errors++;
                continue;
            }
            
            // Debug: Check what we got from GitHub
            if (!fileData.content || fileData.content.trim() === '') {
                console.log(`WARNING: Empty content from GitHub for ${file.path}`);
                console.log(`SHA: ${fileData.sha}`);
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
    
    // Check for drafts that should be deleted (exist locally but not on GitHub)
    console.log("Checking for deleted files...");
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    const toDelete = [];
    
    for (const draft of syncDrafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path && !githubPaths.has(metadata.today_path)) {
            // This file no longer exists on GitHub
            toDelete.push({ draft, path: metadata.today_path });
        }
    }
    
    if (toDelete.length > 0) {
        // Ask for confirmation
        const prompt = Prompt.create();
        prompt.title = "Files Deleted from GitHub";
        prompt.message = `${toDelete.length} file(s) were deleted from GitHub.\n\nDelete the corresponding drafts?\n\nFiles:\n${toDelete.slice(0, 5).map(d => d.path).join('\n')}${toDelete.length > 5 ? `\n...and ${toDelete.length - 5} more` : ''}`;
        prompt.addButton("Delete Drafts");
        prompt.addButton("Keep Drafts");
        
        if (prompt.show() && prompt.buttonPressed === "Delete Drafts") {
            for (const { draft, path } of toDelete) {
                console.log(`Deleting draft for removed file: ${path}`);
                draft.isTrashed = true;
                draft.update();
                stats.deleted++;
            }
            console.log(`Deleted ${stats.deleted} drafts for removed files`);
        } else {
            console.log(`Kept ${toDelete.length} drafts for deleted files`);
        }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Pull completed in ${elapsed}ms`);
    
    return stats;
}

// Push from Drafts to GitHub
function pushToGitHub() {
    console.log("Starting push to GitHub...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
    
    // Get all drafts with today-sync tag (including trashed ones for deletion detection)
    const activeDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    const trashedDrafts = Draft.query("", "trash", ["today-sync"], [], "modified", false, false);
    
    console.log(`Found ${activeDrafts.length} active drafts and ${trashedDrafts.length} trashed drafts`);
    
    const http = HTTP.create();
    
    // First, handle deletions - check trashed drafts that have GitHub paths
    const toDeleteFromGitHub = [];
    for (const draft of trashedDrafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path && metadata.today_sha) {
            // This draft was synced before and is now trashed
            toDeleteFromGitHub.push({ 
                path: metadata.today_path, 
                sha: metadata.today_sha,
                draft: draft 
            });
        }
    }
    
    if (toDeleteFromGitHub.length > 0) {
        // Ask for confirmation to delete from GitHub
        const prompt = Prompt.create();
        prompt.title = "Delete Files from GitHub";
        prompt.message = `${toDeleteFromGitHub.length} trashed draft(s) have corresponding files on GitHub.\n\nDelete these files from GitHub?\n\nFiles:\n${toDeleteFromGitHub.slice(0, 5).map(d => d.path).join('\n')}${toDeleteFromGitHub.length > 5 ? `\n...and ${toDeleteFromGitHub.length - 5} more` : ''}`;
        prompt.addButton("Delete from GitHub");
        prompt.addButton("Keep on GitHub");
        
        if (prompt.show() && prompt.buttonPressed === "Delete from GitHub") {
            const successfullyDeleted = [];
            
            for (const { path, sha, draft } of toDeleteFromGitHub) {
                try {
                    // Delete file from GitHub
                    const deleteResponse = http.request({
                        "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`,
                        "method": "DELETE",
                        "data": {
                            "message": `Delete ${path} (draft was trashed)`,
                            "sha": sha,
                            "branch": CONFIG.branch
                        },
                        "headers": {
                            "Authorization": `Bearer ${CONFIG.token}`,
                            "Accept": "application/vnd.github.v3+json",
                            "Content-Type": "application/json",
                            "User-Agent": "Drafts-Today-Sync"
                        }
                    });
                    
                    if (deleteResponse.success) {
                        console.log(`Deleted from GitHub: ${path}`);
                        successfullyDeleted.push(draft);
                        stats.deleted++;
                    } else {
                        console.log(`Failed to delete ${path}: ${deleteResponse.statusCode}`);
                        stats.errors++;
                    }
                } catch (error) {
                    console.log(`Error deleting ${path}: ${error}`);
                    stats.errors++;
                }
            }
            
            // Remove sync tags from successfully deleted drafts
            for (const draft of successfullyDeleted) {
                draft.removeTag("today-sync");
                draft.update();
            }
            console.log(`Removed sync tags from ${successfullyDeleted.length} deleted drafts`);
        } else if (prompt.buttonPressed === "Keep on GitHub") {
            // Remove sync tags from trashed drafts so they won't be prompted again
            for (const { draft } of toDeleteFromGitHub) {
                draft.removeTag("today-sync");
                draft.update();
            }
            console.log(`Kept files on GitHub, removed sync tags from ${toDeleteFromGitHub.length} trashed drafts`);
        }
    }
    
    // Now process active drafts for create/update
    const drafts = activeDrafts;
    
    for (const draft of drafts) {
        try {
            // Skip empty drafts
            if (!draft.content || draft.content.trim().length === 0) {
                stats.skipped++;
                continue;
            }
            
            // Extract metadata and content
            const { metadata, content: rawContent } = extractMetadata(draft.content);
            
            // Determine path
            let todayPath = metadata.today_path;
            if (!todayPath) {
                // Skip drafts without a today_path - these are orphaned drafts
                // that shouldn't create new files on GitHub
                console.log(`Skipping draft without today_path: ${draft.title || "Untitled"}`);
                stats.skipped++;
                continue;
            }
            
            // Check if file exists on GitHub
            const checkResponse = http.request({
                "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${todayPath}`,
                "method": "GET",
                "headers": {
                    "Authorization": `Bearer ${CONFIG.token}`,
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Drafts-Today-Sync"
                }
            });
            
            let existingFile = null;
            if (checkResponse.success) {
                existingFile = JSON.parse(checkResponse.responseText);
                
                // Check if content changed
                // GitHub returns base64 with newlines, need to clean it
                const cleanBase64 = existingFile.content.replace(/\n/g, '');
                const remoteContent = decodeBase64(cleanBase64);
                if (remoteContent.trim() === rawContent.trim()) {
                    // Update SHA if different
                    if (metadata.today_sha !== existingFile.sha) {
                        draft.content = updateMetadata(draft.content, {
                            today_sha: existingFile.sha
                        });
                        draft.update();
                    }
                    stats.skipped++;
                    continue;
                }
            }
            
            // Upload to GitHub
            const requestBody = {
                "message": existingFile ? 
                    `Update ${todayPath} from Drafts` : 
                    `Create ${todayPath} from Drafts`,
                "content": encodeBase64(rawContent.trim()),
                "branch": CONFIG.branch
            };
            
            if (existingFile) {
                requestBody.sha = existingFile.sha;
            }
            
            const uploadResponse = http.request({
                "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${todayPath}`,
                "method": "PUT",
                "data": requestBody,
                "headers": {
                    "Authorization": `Bearer ${CONFIG.token}`,
                    "Accept": "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                    "User-Agent": "Drafts-Today-Sync"
                }
            });
            
            if (uploadResponse.success) {
                const result = JSON.parse(uploadResponse.responseText);
                
                // Update draft metadata
                draft.content = updateMetadata(draft.content, {
                    today_path: todayPath,
                    today_sha: result.content.sha,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                draft.update();
                
                if (existingFile) {
                    stats.updated++;
                    console.log(`Updated: ${todayPath}`);
                } else {
                    stats.created++;
                    console.log(`Created: ${todayPath}`);
                }
            } else {
                console.log(`Failed to upload ${todayPath}: ${uploadResponse.statusCode}`);
                stats.errors++;
            }
        } catch (error) {
            console.log(`Error processing draft: ${error}`);
            stats.errors++;
        }
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`Push completed in ${elapsed}ms`);
    
    return stats;
}

// Quick sync (both directions)
function quickSync() {
    console.log("Starting quick sync...");
    
    // Pull first
    const pullStats = pullFromGitHub();
    
    // Then push
    const pushStats = pushToGitHub();
    
    return { pull: pullStats, push: pushStats };
}

// ============ DIAGNOSTIC OPERATIONS ============

// Diagnose sync issues
function diagnoseSyncIssues() {
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    console.log(`Found ${syncDrafts.length} drafts with today-sync tag`);
    
    const issues = {
        noMetadata: [],
        noPath: [],
        noSha: [],
        hasError: [],
        healthy: [],
        duplicates: {} // Group by today_path
    };
    
    for (const draft of syncDrafts) {
        const { metadata, content } = extractMetadata(draft.content);
        const hasMetadata = Object.keys(metadata).length > 0;
        
        // Get first line as title
        const lines = content.trim().split('\n');
        const title = lines[0].replace(/^#\s*/, '').trim() || "Untitled";
        
        const draftInfo = {
            title: title,
            uuid: draft.uuid,
            tags: draft.tags.join(", "),
            metadata: metadata,
            draft: draft // Keep reference for operations
        };
        
        // Track duplicates by today_path
        if (metadata.today_path) {
            if (!issues.duplicates[metadata.today_path]) {
                issues.duplicates[metadata.today_path] = [];
            }
            issues.duplicates[metadata.today_path].push(draftInfo);
        }
        
        // Categorize issues
        if (draft.tags.includes("sync-error")) {
            issues.hasError.push(draftInfo);
        } else if (!hasMetadata) {
            issues.noMetadata.push(draftInfo);
        } else if (!metadata.today_path) {
            issues.noPath.push(draftInfo);
        } else if (!metadata.today_sha) {
            issues.noSha.push(draftInfo);
        } else {
            issues.healthy.push(draftInfo);
        }
    }
    
    return issues;
}

// Clean up duplicate drafts
function cleanupDuplicates(duplicateGroups) {
    let deletedCount = 0;
    let report = "";
    
    for (const [path, drafts] of Object.entries(duplicateGroups)) {
        if (drafts.length <= 1) continue;
        
        console.log(`Processing ${path} with ${drafts.length} duplicates`);
        report += `\n${path}: `;
        
        // Try to fetch from GitHub
        const githubFile = fetchGitHubFile(path);
        
        if (!githubFile || !githubFile.exists) {
            // File doesn't exist on GitHub - keep one, delete rest
            report += `keeping 1, deleting ${drafts.length - 1} (no GitHub file)`;
            
            // Keep first, mark with sync-error
            const keeper = drafts[0].draft;
            if (!keeper.tags.includes("sync-error")) {
                keeper.addTag("sync-error");
                keeper.update();
            }
            
            // Delete the rest
            for (let i = 1; i < drafts.length; i++) {
                drafts[i].draft.isTrashed = true;
                drafts[i].draft.update();
                deletedCount++;
            }
        } else {
            // File exists - keep the one matching GitHub
            let matchingDraft = null;
            
            for (const draftInfo of drafts) {
                const { content: draftContent } = extractMetadata(draftInfo.draft.content);
                if (draftContent.trim() === githubFile.content.trim()) {
                    matchingDraft = draftInfo;
                    break;
                }
            }
            
            if (matchingDraft) {
                report += `keeping GitHub match, deleting ${drafts.length - 1}`;
                
                // Update SHA if needed
                if (matchingDraft.metadata.today_sha !== githubFile.sha) {
                    matchingDraft.draft.content = updateMetadata(matchingDraft.draft.content, {
                        today_sha: githubFile.sha
                    });
                    matchingDraft.draft.update();
                }
                
                // Delete all others
                for (const draftInfo of drafts) {
                    if (draftInfo.uuid !== matchingDraft.uuid) {
                        draftInfo.draft.isTrashed = true;
                        draftInfo.draft.update();
                        deletedCount++;
                    }
                }
            } else {
                // No match - keep newest
                report += `no GitHub match, keeping newest`;
                const sortedDrafts = drafts.sort((a, b) => 
                    b.draft.modifiedAt - a.draft.modifiedAt
                );
                
                // Keep first (newest)
                sortedDrafts[0].draft.addTag("needs-sync");
                sortedDrafts[0].draft.update();
                
                // Delete rest
                for (let i = 1; i < sortedDrafts.length; i++) {
                    sortedDrafts[i].draft.isTrashed = true;
                    sortedDrafts[i].draft.update();
                    deletedCount++;
                }
            }
        }
    }
    
    return { deletedCount, report };
}

// Clear sync error tags
function clearSyncErrors() {
    const errorDrafts = Draft.query("", "all", ["sync-error"], [], "modified", false, false);
    let clearedCount = 0;
    
    for (const draft of errorDrafts) {
        draft.removeTag("sync-error");
        draft.update();
        clearedCount++;
    }
    
    return clearedCount;
}

// ============ MAIN MENU AND EXECUTION ============

function main() {
    // Setup credentials first
    if (!setupCredentials()) {
        app.displayErrorMessage("GitHub credentials required");
        context.fail("No credentials");
        return;
    }
    
    // Create menu
    const prompt = Prompt.create();
    prompt.title = "Today Sync Operations";
    prompt.message = "Choose an operation to perform:";
    
    prompt.addButton("🔄 Quick Sync", "quick");
    prompt.addButton("⬇️ Pull from GitHub", "pull");
    prompt.addButton("⬆️ Push to GitHub", "push");
    prompt.addButton("🔍 Diagnose Issues", "diagnose");
    prompt.addButton("🧹 Clean Duplicates", "cleanup");
    prompt.addButton("❌ Clear Sync Errors", "clear-errors");
    prompt.addButton("Cancel");
    
    if (!prompt.show()) {
        context.cancel("User cancelled");
        return;
    }
    
    const operation = prompt.buttonPressed;
    
    try {
        let result;
        let message;
        
        switch (operation) {
            case "quick":
                result = quickSync();
                message = `Quick Sync Complete\n\nPull: ${result.pull.created} new, ${result.pull.updated} updated\nPush: ${result.push.created} new, ${result.push.updated} updated`;
                app.displaySuccessMessage("Quick sync complete!");
                break;
                
            case "pull":
                result = pullFromGitHub();
                message = `Pull Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pulled ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
                
            case "push":
                result = pushToGitHub();
                message = `Push Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pushed ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
                
            case "diagnose":
                const issues = diagnoseSyncIssues();
                
                // Create diagnostic report
                let report = `# Sync Diagnostics\n\n`;
                report += `Total drafts: ${issues.healthy.length + issues.hasError.length + issues.noMetadata.length + issues.noPath.length + issues.noSha.length}\n`;
                report += `Healthy: ${issues.healthy.length}\n`;
                report += `With sync-error tag: ${issues.hasError.length}\n`;
                report += `Missing metadata: ${issues.noMetadata.length}\n`;
                report += `Missing path: ${issues.noPath.length}\n`;
                report += `Missing SHA: ${issues.noSha.length}\n\n`;
                
                // Show drafts with no metadata at all
                if (issues.noMetadata.length > 0) {
                    report += `## Drafts with no metadata (${issues.noMetadata.length}):\n\n`;
                    report += `These drafts have the today-sync tag but no sync metadata - they shouldn't be synced:\n\n`;
                    for (const draft of issues.noMetadata.slice(0, 5)) {
                        report += `- **${draft.title}**\n`;
                        report += `  - Tags: ${draft.tags}\n`;
                    }
                    if (issues.noMetadata.length > 5) {
                        report += `- ...and ${issues.noMetadata.length - 5} more\n`;
                    }
                    
                    // Offer to remove sync tags
                    const cleanupPrompt = Prompt.create();
                    cleanupPrompt.title = "Invalid Sync Drafts";
                    cleanupPrompt.message = `Found ${issues.noMetadata.length} drafts with today-sync tag but no metadata.\n\nRemove the sync tag from these drafts?`;
                    cleanupPrompt.addButton("Remove sync tags");
                    cleanupPrompt.addButton("Keep as-is");
                    
                    if (cleanupPrompt.show() && cleanupPrompt.buttonPressed === "Remove sync tags") {
                        let cleaned = 0;
                        for (const draftInfo of issues.noMetadata) {
                            draftInfo.draft.removeTag("today-sync");
                            draftInfo.draft.update();
                            cleaned++;
                        }
                        report += `\n### Action taken: Removed sync tags from ${cleaned} drafts\n`;
                        app.displaySuccessMessage(`Removed sync tags from ${cleaned} drafts`);
                    }
                    report += `\n`;
                }
                
                // Show details of error drafts
                if (issues.hasError.length > 0) {
                    report += `## Drafts with sync-error tag:\n\n`;
                    for (const draft of issues.hasError) {
                        report += `- **${draft.title}**\n`;
                        report += `  - Path: ${draft.metadata.today_path || "missing"}\n`;
                        report += `  - SHA: ${draft.metadata.today_sha ? "present" : "missing"}\n`;
                        report += `  - Tags: ${draft.tags}\n\n`;
                    }
                }
                
                // Show drafts missing path with cleanup option
                if (issues.noPath.length > 0) {
                    report += `## Drafts missing today_path (${issues.noPath.length}):\n\n`;
                    report += `These drafts have metadata but no path - likely old drafts from before sync was working:\n\n`;
                    for (const draft of issues.noPath) {
                        report += `- **${draft.title}**\n`;
                        report += `  - UUID: ${draft.uuid.substring(0, 8)}...\n`;
                        report += `  - Tags: ${draft.tags}\n`;
                        report += `  - Created: ${draft.draft.createdAt.toISOString().split('T')[0]}\n`;
                        report += `  - Modified: ${draft.draft.modifiedAt.toISOString().split('T')[0]}\n`;
                        if (draft.metadata.today_sha) {
                            report += `  - Has SHA (strange!): ${draft.metadata.today_sha.substring(0, 8)}...\n`;
                        }
                        report += `\n`;
                    }
                    
                    // Offer to clean up these orphaned drafts
                    const cleanupPrompt = Prompt.create();
                    cleanupPrompt.title = "Orphaned Drafts Found";
                    cleanupPrompt.message = `Found ${issues.noPath.length} drafts with metadata but no today_path.\n\nThese appear to be old drafts from before the sync system was fully working.\n\nWhat would you like to do?`;
                    cleanupPrompt.addButton("Remove sync tags", "remove-tags");
                    cleanupPrompt.addButton("Move to trash", "trash");
                    cleanupPrompt.addButton("Keep as-is", "keep");
                    
                    if (cleanupPrompt.show()) {
                        if (cleanupPrompt.buttonPressed === "remove-tags") {
                            let cleaned = 0;
                            for (const draftInfo of issues.noPath) {
                                draftInfo.draft.removeTag("today-sync");
                                draftInfo.draft.update();
                                cleaned++;
                            }
                            report += `\n### Action taken: Removed sync tags from ${cleaned} orphaned drafts\n`;
                            app.displaySuccessMessage(`Removed sync tags from ${cleaned} drafts`);
                        } else if (cleanupPrompt.buttonPressed === "trash") {
                            let trashed = 0;
                            for (const draftInfo of issues.noPath) {
                                draftInfo.draft.isTrashed = true;
                                draftInfo.draft.update();
                                trashed++;
                            }
                            report += `\n### Action taken: Moved ${trashed} orphaned drafts to trash\n`;
                            app.displaySuccessMessage(`Moved ${trashed} drafts to trash`);
                        } else {
                            report += `\n### Action taken: Kept orphaned drafts as-is\n`;
                        }
                    }
                    report += `\n`;
                }
                
                // Show healthy drafts
                if (issues.healthy.length > 0) {
                    report += `## Healthy drafts:\n\n`;
                    for (const draft of issues.healthy.slice(0, 10)) {
                        report += `- ${draft.title} (${draft.metadata.today_path})\n`;
                    }
                    if (issues.healthy.length > 10) {
                        report += `- ...and ${issues.healthy.length - 10} more\n`;
                    }
                    report += `\n`;
                }
                
                // Check for duplicates
                let duplicateCount = 0;
                const duplicatePaths = [];
                for (const [path, drafts] of Object.entries(issues.duplicates)) {
                    if (drafts.length > 1) {
                        duplicateCount++;
                        duplicatePaths.push(path);
                        report += `\n## Duplicate: ${path} (${drafts.length} copies)\n`;
                        for (const draft of drafts) {
                            report += `- ${draft.title} [${draft.uuid.substring(0, 8)}...]\n`;
                        }
                    }
                }
                
                if (duplicateCount > 0) {
                    // Offer to clean up
                    const cleanupPrompt = Prompt.create();
                    cleanupPrompt.title = "Duplicates Found";
                    cleanupPrompt.message = `Found ${duplicateCount} paths with duplicates. Clean them up?`;
                    cleanupPrompt.addButton("Clean Up");
                    cleanupPrompt.addButton("Skip");
                    
                    if (cleanupPrompt.show() && cleanupPrompt.buttonPressed === "Clean Up") {
                        const cleanupResult = cleanupDuplicates(issues.duplicates);
                        report += `\n\nCleaned up ${cleanupResult.deletedCount} duplicates`;
                        report += cleanupResult.report;
                    }
                }
                
                // Create or update diagnostic draft
                let diagDraft = Draft.query("# Sync Diagnostics", "inbox", [], [], "modified", true, false)[0];
                if (!diagDraft) {
                    diagDraft = Draft.create();
                }
                diagDraft.content = report;
                diagDraft.update();
                editor.load(diagDraft);
                
                app.displayInfoMessage(`Found ${issues.hasError.length + issues.noMetadata.length + issues.noPath.length + issues.noSha.length} issues`);
                break;
                
            case "cleanup":
                const diagnostics = diagnoseSyncIssues();
                let dupCount = 0;
                for (const [path, drafts] of Object.entries(diagnostics.duplicates)) {
                    if (drafts.length > 1) dupCount++;
                }
                
                if (dupCount === 0) {
                    app.displaySuccessMessage("No duplicates found!");
                } else {
                    const cleanResult = cleanupDuplicates(diagnostics.duplicates);
                    app.displaySuccessMessage(`Deleted ${cleanResult.deletedCount} duplicates`);
                    message = `Cleanup Complete\n\nDeleted: ${cleanResult.deletedCount} drafts\n${cleanResult.report}`;
                }
                break;
                
            case "clear-errors":
                const cleared = clearSyncErrors();
                app.displaySuccessMessage(`Cleared ${cleared} sync errors`);
                message = `Cleared ${cleared} drafts with sync-error tags`;
                break;
                
            default:
                context.cancel("Operation cancelled");
                return;
        }
        
        // Log the result if we have a message
        if (message) {
            console.log(message);
        }
        
    } catch (error) {
        app.displayErrorMessage(`Operation failed: ${error.message}`);
        console.log(error);
        context.fail(error.message);
    }
}

// Run the main function
main();
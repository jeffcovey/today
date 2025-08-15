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
    token: null, // Will be set from credentials
    lastSyncKey: 'today_sync_last_timestamp' // Key for storing last sync time
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
    
    // Check for HTML comment format (old format that shows in preview)
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
    
    // Legacy: old incomplete HTML comment format
    const oldBottomMetadataRegex = /\n\n<!-- sync-metadata -->\n---\n([\s\S]*?)\n---$/;
    match = content.match(oldBottomMetadataRegex);
    
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
        
        const contentWithoutMetadata = content.replace(oldBottomMetadataRegex, '');
        return { metadata, content: contentWithoutMetadata, needsFormatFix: true };
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
        if (value !== null && value !== undefined) {
            // Escape parentheses in values to avoid breaking the comment syntax
            const escapedValue = value.replace(/[()]/g, '\\$&');
            metadataSection += `[//]: # (${key}: ${escapedValue})\n`;
        }
    }
    metadataSection += "[//]: # (sync-metadata-end)";
    
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
        const extracted = extractMetadata(draft.content);
        
        // Auto-fix old metadata format if needed
        if (extracted.needsFormatFix && extracted.metadata.today_path) {
            console.log(`Auto-fixing metadata format for: ${extracted.metadata.today_path}`);
            draft.content = updateMetadata(extracted.content, extracted.metadata);
            draft.update();
        }
        
        if (extracted.metadata.today_path === todayPath) {
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

// ============ MERGE FUNCTIONS ============

// Smart merge that uses timestamps and proper conflict markers
function smartMerge(localContent, remoteContent, localModified, remoteModified, lastSyncTime) {
    // If contents are identical, no conflict
    if (localContent.trim() === remoteContent.trim()) {
        return {
            merged: true,
            content: localContent,
            conflictCount: 0
        };
    }
    
    // Check if only one side changed since last sync
    const localChangedSinceSync = !lastSyncTime || localModified > lastSyncTime;
    const remoteChangedSinceSync = !lastSyncTime || remoteModified > lastSyncTime;
    
    // If only remote changed, take remote
    if (!localChangedSinceSync && remoteChangedSinceSync) {
        console.log("Only GitHub changed, taking GitHub version");
        return {
            merged: true,
            content: remoteContent,
            conflictCount: 0
        };
    }
    
    // If only local changed, keep local
    if (localChangedSinceSync && !remoteChangedSinceSync) {
        console.log("Only local changed, keeping local version");
        return {
            merged: true,
            content: localContent,
            conflictCount: 0
        };
    }
    
    // If neither changed since sync but they differ, take the newer one
    if (!localChangedSinceSync && !remoteChangedSinceSync) {
        if (localModified > remoteModified) {
            console.log("Local is newer, keeping local");
            return {
                merged: true,
                content: localContent,
                conflictCount: 0
            };
        } else {
            console.log("GitHub is newer, taking GitHub");
            return {
                merged: true,
                content: remoteContent,
                conflictCount: 0
            };
        }
    }
    
    // Both changed since last sync - create proper conflict markers
    console.log("Both sides changed, creating conflict markers");
    return createConflictMarkers(localContent, remoteContent);
}

// Create conflict markers WITHOUT corrupting the content
function createConflictMarkers(localContent, remoteContent) {
    const localLines = localContent.split('\n');
    const remoteLines = remoteContent.split('\n');
    const result = [];
    
    // Simple approach: if files are very different, show whole file conflict
    // This avoids the line-by-line corruption we were seeing
    
    // Calculate similarity
    let matchingLines = 0;
    const maxLines = Math.max(localLines.length, remoteLines.length);
    const minLines = Math.min(localLines.length, remoteLines.length);
    
    for (let i = 0; i < minLines; i++) {
        if (localLines[i] === remoteLines[i]) {
            matchingLines++;
        }
    }
    
    const similarity = matchingLines / maxLines;
    
    // If files are >70% similar, try to show specific conflicts
    if (similarity > 0.7) {
        let i = 0, j = 0;
        let inConflict = false;
        let conflictCount = 0;
        
        while (i < localLines.length || j < remoteLines.length) {
            const localLine = i < localLines.length ? localLines[i] : null;
            const remoteLine = j < remoteLines.length ? remoteLines[j] : null;
            
            // Lines match
            if (localLine === remoteLine) {
                if (inConflict) {
                    result.push('>>>>>>> GITHUB');
                    inConflict = false;
                }
                if (localLine !== null) {
                    result.push(localLine);
                }
                i++;
                j++;
            }
            // Start of conflict
            else {
                if (!inConflict) {
                    result.push('<<<<<<< LOCAL');
                    conflictCount++;
                    inConflict = true;
                }
                
                // Add both versions
                if (localLine !== null) {
                    result.push(localLine);
                    i++;
                }
                if (remoteLine !== null && i >= localLines.length) {
                    result.push('======= GITHUB');
                    while (j < remoteLines.length) {
                        result.push(remoteLines[j++]);
                    }
                }
            }
        }
        
        if (inConflict) {
            result.push('>>>>>>> GITHUB');
        }
        
        return {
            merged: false,
            content: result.join('\n'),
            conflictCount: conflictCount
        };
    }
    
    // Files are very different, show as one big conflict
    result.push('<<<<<<< LOCAL');
    result.push(...localLines);
    result.push('=======');
    result.push(...remoteLines);
    result.push('>>>>>>> GITHUB');
    
    return {
        merged: false,
        content: result.join('\n'),
        conflictCount: 1
    };
}

// ============ SYNC OPERATIONS ============

// Fetch files modified since a specific date using GitHub API
function fetchModifiedFilesSince(sinceDate) {
    if (!sinceDate) return null;
    
    const http = HTTP.create();
    
    // Use commits API to find files changed since date
    const sinceISO = sinceDate.toISOString();
    
    try {
        const commitsResponse = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/commits?since=${sinceISO}&per_page=100`,
            "method": "GET",
            "headers": {
                "Authorization": `Bearer ${CONFIG.token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Drafts-Today-Sync"
            }
        });
        
        if (!commitsResponse.success) {
            console.log(`Could not fetch commits since ${sinceISO}, falling back to full sync`);
            return null;
        }
        
        const commits = JSON.parse(commitsResponse.responseText);
        
        if (!commits || commits.length === 0) {
            console.log("No commits found since last sync");
            return { modified: [], deleted: [] };
        }
        
        const modifiedPaths = new Set();
        const deletedPaths = new Set();
        
        // Limit to checking first 10 commits to avoid too many API calls
        const commitsToCheck = commits.slice(0, 10);
        
        for (const commit of commitsToCheck) {
            // Skip merge commits
            if (commit.commit && commit.commit.message && commit.commit.message.startsWith("Merge")) {
                continue;
            }
            
            // Use the commit comparison API instead to get files in one call
            const compareResponse = http.request({
                "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/compare/${commit.sha}~1...${commit.sha}`,
                "method": "GET",
                "headers": {
                    "Authorization": `Bearer ${CONFIG.token}`,
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Drafts-Today-Sync"
                }
            });
            
            if (compareResponse.success) {
                const compareData = JSON.parse(compareResponse.responseText);
                if (compareData.files) {
                    for (const file of compareData.files) {
                        if ((file.filename.startsWith("notes/") || file.filename.startsWith("projects/")) && 
                            file.filename.endsWith(".md")) {
                            // Check if file was deleted
                            if (file.status === "removed") {
                                deletedPaths.add(file.filename);
                                modifiedPaths.delete(file.filename); // Remove from modified if it was there
                            } else {
                                // Only add to modified if not deleted
                                if (!deletedPaths.has(file.filename)) {
                                    modifiedPaths.add(file.filename);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        const result = {
            modified: Array.from(modifiedPaths),
            deleted: Array.from(deletedPaths)
        };
        console.log(`Found ${result.modified.length} modified and ${result.deleted.length} deleted files from recent commits`);
        return result;
        
    } catch (error) {
        console.log(`Error fetching modified files: ${error}, falling back to full sync`);
        return null;
    }
}

// Pull from GitHub to Drafts
// Fetch the file dates index from GitHub
function fetchFileDatesIndex() {
    const http = HTTP.create();
    try {
        const response = http.request({
            "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/.file-dates.json`,
            "method": "GET",
            "headers": {
                "Authorization": `Bearer ${CONFIG.token}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Drafts-Today-Sync"
            }
        });
        
        if (response.success) {
            const data = JSON.parse(response.responseText);
            const cleanBase64 = data.content.replace(/\n/g, '');
            const jsonContent = decodeBase64(cleanBase64);
            return JSON.parse(jsonContent);
        }
    } catch (error) {
        console.log(`Could not fetch file dates index: ${error}`);
    }
    return null;
}

function pullFromGitHub(incrementalSync = true) {
    console.log(incrementalSync ? "Starting incremental pull from GitHub..." : "Starting full pull from GitHub...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
    
    // Check for incremental sync opportunity
    const lastSyncTime = incrementalSync ? getLastSyncTime() : null;
    let changesSinceSync = null;
    
    if (lastSyncTime) {
        console.log(`Last sync was at ${lastSyncTime.toISOString()}`);
        changesSinceSync = fetchModifiedFilesSince(lastSyncTime);
        if (changesSinceSync && changesSinceSync.modified.length === 0 && changesSinceSync.deleted.length === 0) {
            console.log("No files modified or deleted since last sync");
            updateLastSyncTime();
            return stats;
        }
        if (changesSinceSync) {
            console.log(`Found ${changesSinceSync.modified.length} modified and ${changesSinceSync.deleted.length} deleted files since last sync`);
        }
    }
    
    // Fetch the file dates index
    const fileDatesIndex = fetchFileDatesIndex();
    if (!fileDatesIndex) {
        console.log("Warning: Could not fetch file dates index");
    }
    
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
    let noteFiles = tree.tree.filter(item => 
        item.type === "blob" && 
        (item.path.startsWith("notes/") || item.path.startsWith("projects/")) && 
        item.path.endsWith(".md") &&
        !item.path.includes("/inbox/") // Skip inbox files
    );
    
    // If we have a list of modified files, filter to only those
    if (changesSinceSync && changesSinceSync.modified.length > 0) {
        const modifiedSet = new Set(changesSinceSync.modified);
        noteFiles = noteFiles.filter(item => modifiedSet.has(item.path));
        console.log(`Filtered to ${noteFiles.length} modified files for incremental sync`);
    }
    
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
                    // SHA matches, check if local draft was modified more recently
                    const lastSync = metadata.last_sync ? new Date(metadata.last_sync) : null;
                    if (lastSync && draft.modifiedAt <= lastSync) {
                        // No local changes since last sync, skip
                        stats.skipped++;
                        continue;
                    }
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
                
                // Try to set draft date from the file dates index
                if (fileDatesIndex && fileDatesIndex[file.path]) {
                    try {
                        const createdDate = new Date(fileDatesIndex[file.path]);
                        if (!isNaN(createdDate.getTime())) {
                            draft.createdAt = createdDate;
                            // Keep modifiedAt as current for new drafts
                            draft.modifiedAt = new Date();
                            console.log(`Set draft creation date from index: ${createdDate.toISOString()}`);
                        }
                    } catch (e) {
                        console.log(`Could not parse date from index for ${file.path}: ${e}`);
                    }
                } else {
                    // Fallback: Try to parse date from filename
                    // Common patterns: 2025-08-13, 2025-08-13-14:30:00-UTC
                    const dateMatch = file.path.match(/(\d{4}-\d{2}-\d{2})(?:[-_](\d{2})[:\-]?(\d{2})[:\-]?(\d{2}))?/);
                    if (dateMatch) {
                        let dateStr = dateMatch[1]; // YYYY-MM-DD
                        if (dateMatch[2]) {
                            // Has time component
                            dateStr += `T${dateMatch[2]}:${dateMatch[3] || '00'}:${dateMatch[4] || '00'}`;
                        } else {
                            dateStr += 'T12:00:00'; // Default to noon if no time
                        }
                        
                        try {
                            const parsedDate = new Date(dateStr);
                            if (!isNaN(parsedDate.getTime())) {
                                // Set both created and modified to the parsed date
                                // This helps maintain chronological order in Drafts
                                draft.createdAt = parsedDate;
                                draft.modifiedAt = parsedDate;
                                console.log(`Set draft date to ${parsedDate.toISOString()} from filename`);
                            }
                        } catch (e) {
                            console.log(`Could not parse date from ${file.path}: ${e}`);
                        }
                    }
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
    const toDelete = [];
    
    if (!incrementalSync) {
        // During full sync, check all drafts against the complete GitHub file list
        console.log("Checking for deleted files (full sync)...");
        const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
        
        for (const draft of syncDrafts) {
            const { metadata } = extractMetadata(draft.content);
            if (metadata.today_path && !githubPaths.has(metadata.today_path)) {
                // This file no longer exists on GitHub
                toDelete.push({ draft, path: metadata.today_path });
            }
        }
    } else if (changesSinceSync && changesSinceSync.deleted.length > 0) {
        // During incremental sync, only check files that were explicitly deleted
        console.log(`Checking ${changesSinceSync.deleted.length} deleted files from recent commits...`);
        const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
        const deletedSet = new Set(changesSinceSync.deleted);
        
        for (const draft of syncDrafts) {
            const { metadata } = extractMetadata(draft.content);
            if (metadata.today_path && deletedSet.has(metadata.today_path)) {
                // This file was deleted in a recent commit
                toDelete.push({ draft, path: metadata.today_path });
            }
        }
    } else {
        console.log("No deletion check needed for this incremental sync");
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
    
    // Update last sync time on successful pull
    if (stats.errors === 0) {
        updateLastSyncTime();
    }
    
    return stats;
}

// Push from Drafts to GitHub
function pushToGitHub(onlyModified = true) {
    console.log(onlyModified ? "Starting push to GitHub (modified only)..." : "Starting full push to GitHub...");
    const startTime = Date.now();
    const stats = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
    
    // Get all drafts with today-sync tag (including trashed ones for deletion detection)
    let activeDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    // If onlyModified, filter to drafts modified since last sync
    if (onlyModified) {
        const lastSyncTime = getLastSyncTime();
        if (lastSyncTime) {
            const originalCount = activeDrafts.length;
            activeDrafts = activeDrafts.filter(draft => {
                // Check if draft was modified after last sync
                if (draft.modifiedAt > lastSyncTime) {
                    return true;
                }
                
                // Also check if metadata indicates it needs sync
                const { metadata } = extractMetadata(draft.content);
                const draftLastSync = metadata.last_sync ? new Date(metadata.last_sync) : null;
                return !draftLastSync || draft.modifiedAt > draftLastSync;
            });
            console.log(`Filtered from ${originalCount} to ${activeDrafts.length} modified drafts`);
        }
    }
    const trashedDrafts = Draft.query("", "trash", ["today-sync"], [], "modified", false, false);
    
    console.log(`Found ${activeDrafts.length} active drafts and ${trashedDrafts.length} trashed drafts`);
    
    const http = HTTP.create();
    
    // First, handle deletions - check trashed drafts that have GitHub paths
    const toDeleteFromGitHub = [];
    for (const draft of trashedDrafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path && metadata.today_sha) {
            // Check if file actually exists on GitHub before prompting
            const checkResponse = http.request({
                "url": `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${metadata.today_path}`,
                "method": "GET",
                "headers": {
                    "Authorization": `Bearer ${CONFIG.token}`,
                    "Accept": "application/vnd.github.v3+json",
                    "User-Agent": "Drafts-Today-Sync"
                }
            });
            
            if (checkResponse.success) {
                // File exists on GitHub, add to deletion list
                toDeleteFromGitHub.push({ 
                    path: metadata.today_path, 
                    sha: metadata.today_sha,
                    draft: draft 
                });
            } else if (checkResponse.statusCode === 404) {
                // File already deleted from GitHub, just remove sync tags
                console.log(`File already deleted from GitHub: ${metadata.today_path}, removing sync tags`);
                draft.removeTag("today-sync");
                draft.update();
            }
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
                    } else if (deleteResponse.statusCode === 404) {
                        // File doesn't exist on GitHub, treat as successful deletion
                        console.log(`File already gone from GitHub: ${path}`);
                        successfullyDeleted.push(draft);
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
                
                // First check SHA to avoid unnecessary content comparison
                if (metadata.today_sha === existingFile.sha) {
                    // SHA matches, content hasn't changed on GitHub
                    stats.skipped++;
                    continue;
                }
                
                // SHA different, check if content actually changed
                // GitHub returns base64 with newlines, need to clean it
                const cleanBase64 = existingFile.content.replace(/\n/g, '');
                const remoteContent = decodeBase64(cleanBase64);
                if (remoteContent.trim() === rawContent.trim()) {
                    // Content same, just update SHA
                    draft.content = updateMetadata(draft.content, {
                        today_sha: existingFile.sha,
                        last_sync: new Date().toISOString()
                    });
                    draft.update();
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
    
    // Update last sync time on successful push
    if (stats.errors === 0) {
        updateLastSyncTime();
    }
    
    return stats;
}

// Quick sync (both directions)
function quickSync(forceFullSync = false) {
    console.log(forceFullSync ? "Starting full sync..." : "Starting quick incremental sync...");
    
    // First, get the current state of GitHub files (just metadata, not content)
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
    const githubSHAs = {};
    tree.tree.filter(item => 
        item.type === "blob" && 
        (item.path.startsWith("notes/") || item.path.startsWith("projects/")) && 
        item.path.endsWith(".md")
    ).forEach(item => {
        githubSHAs[item.path] = item.sha;
    });
    
    // Now check each draft to categorize sync needs
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    const conflicts = [];
    const needsPush = [];
    const needsPull = [];
    
    for (const draft of syncDrafts) {
        const { metadata, content: localContent } = extractMetadata(draft.content);
        
        if (!metadata.today_path) continue;
        
        const githubSHA = githubSHAs[metadata.today_path];
        const storedSHA = metadata.today_sha;
        
        if (!githubSHA) {
            // File doesn't exist on GitHub - needs push if not empty
            if (localContent.trim().length > 0) {
                needsPush.push(draft);
            }
        } else if (githubSHA === storedSHA) {
            // GitHub hasn't changed - safe to push any local changes
            // Check if we have local changes by comparing content
            // (We'd need to fetch to compare, so just mark for push check)
            needsPush.push(draft);
        } else {
            // GitHub has changed (githubSHA !== storedSHA)
            // Need to check if we also have local changes
            // For now, we'll need to fetch the content to determine
            const githubFile = fetchGitHubFile(metadata.today_path);
            if (githubFile && githubFile.exists) {
                const remoteContent = githubFile.content.trim();
                const localContentTrimmed = localContent.trim();
                
                if (localContentTrimmed !== remoteContent) {
                    // Use smart merge to decide what to do
                    const lastSyncTime = getLastSyncTime();
                    const localModified = draft.modifiedAt;
                    // We don't have remote modified time easily, so estimate it
                    const remoteModified = new Date(); // Assume recently modified
                    
                    const mergeResult = smartMerge(
                        localContentTrimmed,
                        remoteContent,
                        localModified,
                        remoteModified,
                        lastSyncTime
                    );
                    
                    if (mergeResult.merged) {
                        // Automatic resolution succeeded
                        if (mergeResult.content === localContentTrimmed) {
                            // Keep local version
                            needsPush.push(draft);
                        } else {
                            // Take remote version
                            needsPull.push({
                                draft: draft,
                                path: metadata.today_path,
                                content: mergeResult.content,
                                sha: githubSHA
                            });
                        }
                    } else {
                        // Conflict that needs manual resolution
                        conflicts.push({
                            draft: draft,
                            path: metadata.today_path,
                            localContent: localContentTrimmed,
                            remoteContent: remoteContent,
                            mergedContent: mergeResult.content,
                            conflictCount: mergeResult.conflictCount,
                            remoteSHA: githubSHA
                        });
                    }
                } else {
                    // Only GitHub changed, we can safely pull
                    needsPull.push({
                        draft: draft,
                        path: metadata.today_path,
                        content: remoteContent,
                        sha: githubSHA
                    });
                }
            }
        }
    }
    
    // Handle conflicts with proper markers
    if (conflicts.length > 0) {
        console.log(`Found ${conflicts.length} conflicts that couldn't be auto-resolved`);
        
        // Show conflicts to user
        const prompt = Prompt.create();
        prompt.title = "Merge Conflicts";
        prompt.message = `${conflicts.length} file(s) have conflicts that need resolution.\n\nConflict markers have been added to help you resolve them:\n<<<<<<< LOCAL (your version)\n=======\n>>>>>>> GITHUB (remote version)\n\nFiles with conflicts:\n${conflicts.slice(0, 5).map(c => `${c.path} (${c.conflictCount} conflicts)`).join('\n')}${conflicts.length > 5 ? `\n...and ${conflicts.length - 5} more` : ''}\n\nWhat would you like to do?`;
        prompt.addButton("Save with Conflict Markers", "markers");
        prompt.addButton("Keep All Local", "local");
        prompt.addButton("Take All GitHub", "remote");
        prompt.addButton("Cancel", "cancel");
            
            if (!prompt.show() || prompt.buttonPressed === "cancel") {
                return { cancelled: true };
            }
            
        if (!prompt.show() || prompt.buttonPressed === "cancel") {
            console.log("Sync cancelled by user");
            return { cancelled: true };
        }
        
        if (prompt.buttonPressed === "markers") {
            // Save with conflict markers for manual resolution
            for (const conflict of conflicts) {
                conflict.draft.content = updateMetadata(conflict.mergedContent, {
                    today_path: conflict.path,
                    today_sha: conflict.remoteSHA,
                    last_sync: new Date().toISOString(),
                    sync_status: "has-conflicts"
                });
                conflict.draft.addTag("has-conflicts");
                conflict.draft.update();
                console.log(`Saved with conflict markers: ${conflict.path}`);
            }
            app.displayInfoMessage(`Saved ${conflicts.length} files with conflict markers for manual resolution`);
        } else if (prompt.buttonPressed === "local") {
            // Keep all local changes
            for (const conflict of conflicts) {
                needsPush.push(conflict.draft);
            }
            console.log("Keeping all local versions");
        } else if (prompt.buttonPressed === "remote") {
            // Take all remote changes
            for (const conflict of conflicts) {
                conflict.draft.content = updateMetadata(conflict.remoteContent, {
                    today_path: conflict.path,
                    today_sha: conflict.remoteSHA,
                    last_sync: new Date().toISOString(),
                    sync_status: "synced"
                });
                conflict.draft.update();
                console.log(`Updated with GitHub version: ${conflict.path}`);
            }
        }
    }
    
    // Apply pull changes first (update from GitHub)
    let pullStats = { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
    for (const item of needsPull) {
        item.draft.content = updateMetadata(item.content, {
            today_path: item.path,
            today_sha: item.sha,
            last_sync: new Date().toISOString(),
            sync_status: "synced"
        });
        item.draft.update();
        pullStats.updated++;
        console.log(`Updated from GitHub: ${item.path}`);
    }
    
    // Then do a pull for any new/modified files
    const fullPullStats = pullFromGitHub(!forceFullSync);
    pullStats.created += fullPullStats.created;
    pullStats.deleted += fullPullStats.deleted;
    pullStats.errors += fullPullStats.errors;
    
    // Finally push any local changes
    const pushStats = pushToGitHub(!forceFullSync);
    
    return { pull: pullStats, push: pushStats };
}

// ============ DIAGNOSTIC OPERATIONS ============

// Diagnose sync issues
function diagnoseSyncIssues() {
    // Get drafts with sync tags (excluding trash - "all" doesn't include trash)
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    // Also get drafts with "notes" but not "today-sync" - these are likely from failed syncs
    const notesOnlyDrafts = Draft.query("", "all", ["notes"], [], "modified", false, false)
        .filter(d => !d.tags.includes("today-sync"));
    
    console.log(`Found ${syncDrafts.length} drafts with today-sync tag`);
    console.log(`Found ${notesOnlyDrafts.length} drafts with notes tag but no today-sync tag`);
    
    const issues = {
        noMetadata: [],
        noPath: [],
        noSha: [],
        hasError: [],
        healthy: [],
        notesOnly: [], // New category for orphaned notes drafts
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
    
    // Process drafts with "notes" tag but no "today-sync" tag
    for (const draft of notesOnlyDrafts) {
        const { metadata, content } = extractMetadata(draft.content);
        const lines = content.trim().split('\n');
        const title = lines[0].replace(/^#\s*/, '').trim() || "Untitled";
        
        issues.notesOnly.push({
            title: title,
            uuid: draft.uuid,
            tags: draft.tags.join(", "),
            metadata: metadata,
            draft: draft,
            hasMetadata: Object.keys(metadata).length > 0,
            hasPath: metadata.today_path || false
        });
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
    prompt.addButton("🔄 Full Sync", "full-sync");
    prompt.addButton("⬇️ Pull from GitHub", "pull");
    prompt.addButton("⬇️ Full Pull", "full-pull");
    prompt.addButton("⬆️ Push to GitHub", "push");
    prompt.addButton("⬆️ Full Push", "full-push");
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
                result = quickSync(false);
                message = `Quick Incremental Sync Complete\n\nPull: ${result.pull.created} new, ${result.pull.updated} updated\nPush: ${result.push.created} new, ${result.push.updated} updated`;
                app.displaySuccessMessage("Quick sync complete!");
                break;
                
            case "full-sync":
                result = quickSync(true);
                message = `Full Sync Complete\n\nPull: ${result.pull.created} new, ${result.pull.updated} updated\nPush: ${result.push.created} new, ${result.push.updated} updated`;
                app.displaySuccessMessage("Full sync complete!");
                break;
                
            case "pull":
                result = pullFromGitHub(true);
                message = `Incremental Pull Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pulled ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
                
            case "full-pull":
                result = pullFromGitHub(false);
                message = `Full Pull Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pulled ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
                
            case "push":
                result = pushToGitHub(true);
                message = `Incremental Push Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pushed ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
            
            case "full-push":
                result = pushToGitHub(false);
                message = `Full Push Complete\n\nCreated: ${result.created}\nUpdated: ${result.updated}\nDeleted: ${result.deleted}\nSkipped: ${result.skipped}\nErrors: ${result.errors}`;
                app.displaySuccessMessage(`Pushed ${result.created + result.updated} changes, deleted ${result.deleted}`);
                break;
                
            case "diagnose":
                // First, fetch the file dates index for fixing dates
                const datesIndex = fetchFileDatesIndex();
                
                const issues = diagnoseSyncIssues();
                
                // Check for drafts with missing creation dates
                let draftsNeedingDates = [];
                if (datesIndex) {
                    const allSyncedDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
                    for (const draft of allSyncedDrafts) {
                        const { metadata } = extractMetadata(draft.content);
                        if (metadata.today_path && !metadata.created_at) {
                            // Check if we have a date for this file
                            if (datesIndex[metadata.today_path]) {
                                draftsNeedingDates.push({
                                    draft: draft,
                                    path: metadata.today_path,
                                    indexDate: datesIndex[metadata.today_path]
                                });
                            }
                        }
                    }
                }
                
                // Create diagnostic report
                let report = `# Sync Diagnostics\n\n`;
                report += `Total drafts with today-sync: ${issues.healthy.length + issues.hasError.length + issues.noMetadata.length + issues.noPath.length + issues.noSha.length}\n`;
                report += `Healthy: ${issues.healthy.length}\n`;
                report += `With sync-error tag: ${issues.hasError.length}\n`;
                report += `Missing metadata: ${issues.noMetadata.length}\n`;
                report += `Missing path: ${issues.noPath.length}\n`;
                report += `Missing SHA: ${issues.noSha.length}\n`;
                report += `**Drafts with 'notes' but not 'today-sync': ${issues.notesOnly.length}**\n`;
                report += `Missing creation dates: ${draftsNeedingDates.length}\n\n`;
                
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
                    
                    // Offer cleanup options
                    const cleanupPrompt = Prompt.create();
                    cleanupPrompt.title = "Invalid Sync Drafts";
                    cleanupPrompt.message = `Found ${issues.noMetadata.length} drafts with today-sync tag but no metadata.\n\nThese are broken sync drafts.\n\nWhat would you like to do?`;
                    cleanupPrompt.addButton("Move to Trash", "trash");
                    cleanupPrompt.addButton("Remove sync tags", "remove-tags");
                    cleanupPrompt.addButton("Keep as-is", "keep");
                    
                    if (cleanupPrompt.show()) {
                        if (cleanupPrompt.buttonPressed === "trash") {
                            let trashed = 0;
                            for (const draftInfo of issues.noMetadata) {
                                draftInfo.draft.isTrashed = true;
                                draftInfo.draft.update();
                                trashed++;
                            }
                            report += `\n### Action taken: Moved ${trashed} broken sync drafts to trash (keeping tags for reference)\n`;
                            app.displaySuccessMessage(`Moved ${trashed} broken sync drafts to trash`);
                        } else if (cleanupPrompt.buttonPressed === "remove-tags") {
                            let cleaned = 0;
                            for (const draftInfo of issues.noMetadata) {
                                draftInfo.draft.removeTag("today-sync");
                                if (draftInfo.draft.tags.includes("notes")) {
                                    draftInfo.draft.removeTag("notes");
                                }
                                draftInfo.draft.update();
                                cleaned++;
                            }
                            report += `\n### Action taken: Removed sync tags from ${cleaned} drafts\n`;
                            app.displaySuccessMessage(`Removed sync tags from ${cleaned} drafts`);
                        } else {
                            report += `\n### Action taken: Kept broken sync drafts as-is\n`;
                        }
                    }
                    report += `\n`;
                }
                
                // Handle drafts with "notes" but not "today-sync" (likely from failed syncs)
                if (issues.notesOnly.length > 0) {
                    report += `## Drafts with 'notes' tag but no 'today-sync' tag (${issues.notesOnly.length}):\n\n`;
                    report += `These drafts appear to be from failed or incomplete syncs.\n\n`;
                    
                    // Show first few drafts
                    for (const draft of issues.notesOnly.slice(0, 5)) {
                        report += `- **${draft.title}**\n`;
                        report += `  - Tags: ${draft.tags}\n`;
                        report += `  - Has metadata: ${draft.hasMetadata ? 'Yes' : 'No'}\n`;
                        if (draft.hasPath) {
                            report += `  - Path: ${draft.hasPath}\n`;
                        }
                    }
                    if (issues.notesOnly.length > 5) {
                        report += `- ...and ${issues.notesOnly.length - 5} more\n`;
                    }
                    
                    // Offer cleanup options
                    const cleanupPrompt = Prompt.create();
                    cleanupPrompt.title = "Orphaned 'notes' Drafts Found";
                    cleanupPrompt.message = `Found ${issues.notesOnly.length} drafts with 'notes' tag but no 'today-sync' tag.\n\nThese appear to be from failed syncs.\n\nWhat would you like to do?`;
                    cleanupPrompt.addButton("Move to Trash", "trash");
                    cleanupPrompt.addButton("Keep as-is", "keep");
                    
                    if (cleanupPrompt.show()) {
                        if (cleanupPrompt.buttonPressed === "trash") {
                            let trashed = 0;
                            for (const draftInfo of issues.notesOnly) {
                                draftInfo.draft.isTrashed = true;
                                draftInfo.draft.update();
                                trashed++;
                            }
                            report += `\n### Action taken: Moved ${trashed} orphaned 'notes' drafts to trash (keeping tags for reference)\n`;
                            app.displaySuccessMessage(`Moved ${trashed} orphaned 'notes' drafts to trash`);
                        } else {
                            report += `\n### Action taken: Kept orphaned 'notes' drafts as-is\n`;
                        }
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
                    cleanupPrompt.addButton("Move to Trash", "trash");
                    cleanupPrompt.addButton("Remove sync tags", "remove-tags");
                    cleanupPrompt.addButton("Keep as-is", "keep");
                    
                    if (cleanupPrompt.show()) {
                        if (cleanupPrompt.buttonPressed === "trash") {
                            let trashed = 0;
                            for (const draftInfo of issues.noPath) {
                                draftInfo.draft.isTrashed = true;
                                draftInfo.draft.update();
                                trashed++;
                            }
                            report += `\n### Action taken: Moved ${trashed} orphaned drafts to trash (keeping tags for reference)\n`;
                            app.displaySuccessMessage(`Moved ${trashed} drafts to trash`);
                        } else if (cleanupPrompt.buttonPressed === "remove-tags") {
                            let cleaned = 0;
                            for (const draftInfo of issues.noPath) {
                                draftInfo.draft.removeTag("today-sync");
                                if (draftInfo.draft.tags.includes("notes")) {
                                    draftInfo.draft.removeTag("notes");
                                }
                                draftInfo.draft.update();
                                cleaned++;
                            }
                            report += `\n### Action taken: Removed sync tags from ${cleaned} orphaned drafts\n`;
                            app.displaySuccessMessage(`Removed sync tags from ${cleaned} drafts`);
                        } else {
                            report += `\n### Action taken: Kept orphaned drafts as-is\n`;
                        }
                    }
                    report += `\n`;
                }
                
                // Handle drafts missing creation dates
                if (draftsNeedingDates.length > 0) {
                    report += `## Drafts missing creation dates (${draftsNeedingDates.length}):\n\n`;
                    report += `These drafts can have their creation dates fixed from the file index:\n\n`;
                    
                    for (const item of draftsNeedingDates.slice(0, 10)) {
                        const title = item.draft.title || "Untitled";
                        report += `- **${title}**\n`;
                        report += `  - Path: ${item.path}\n`;
                        report += `  - Index date: ${item.indexDate}\n`;
                    }
                    
                    if (draftsNeedingDates.length > 10) {
                        report += `- ...and ${draftsNeedingDates.length - 10} more\n`;
                    }
                    
                    // Offer to fix dates
                    const fixPrompt = Prompt.create();
                    fixPrompt.title = "Fix Creation Dates";
                    fixPrompt.message = `Found ${draftsNeedingDates.length} drafts missing creation dates.\n\nWould you like to:\n- Update their metadata with creation dates\n- Set their draft.createdAt timestamps`;
                    fixPrompt.addButton("Fix dates", "fix");
                    fixPrompt.addButton("Skip", "skip");
                    
                    if (fixPrompt.show() && fixPrompt.buttonPressed === "fix") {
                        let fixed = 0;
                        for (const item of draftsNeedingDates) {
                            try {
                                // Parse the date from index
                                const createdDate = new Date(item.indexDate);
                                if (!isNaN(createdDate.getTime())) {
                                    // Update the draft's createdAt timestamp
                                    item.draft.createdAt = createdDate;
                                    
                                    // Update metadata to include created_at
                                    const { metadata, content } = extractMetadata(item.draft.content);
                                    metadata.created_at = item.indexDate;
                                    item.draft.content = updateMetadata(content, metadata);
                                    
                                    item.draft.update();
                                    fixed++;
                                }
                            } catch (error) {
                                console.log(`Error fixing date for ${item.path}: ${error}`);
                            }
                        }
                        report += `\n### Action taken: Fixed creation dates for ${fixed} drafts\n`;
                        app.displaySuccessMessage(`Fixed creation dates for ${fixed} drafts`);
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
                for (const drafts of Object.values(diagnostics.duplicates)) {
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
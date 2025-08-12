// Drafts Action: Quick Sync (Two-Way)
// Performs both pull and push sync operations in sequence
// 
// Setup:
// 1. Use same GitHub token setup as other sync actions
// 2. In Drafts, create new Action called "🔄 Quick Sync"
// 3. Add a "Script" step and paste this code
// 4. Optionally assign keyboard shortcut: Cmd+Shift+S

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

function addMetadata(content, metadata) {
    const metadataText = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    
    return `---\n${metadataText}\n---\n\n${content}`;
}

function updateMetadata(content, updates) {
    const { metadata, content: rawContent } = extractMetadata(content);
    const newMetadata = { ...metadata, ...updates };
    
    const metadataText = Object.entries(newMetadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    
    return `---\n${metadataText}\n---\n\n${rawContent}`;
}

function pathToTags(path) {
    const tags = ["today-sync"];
    
    if (path.startsWith("notes/")) {
        const parts = path.split('/');
        let tagPath = "";
        for (let i = 0; i < parts.length - 1; i++) {
            tagPath = tagPath ? `${tagPath}/${parts[i]}` : parts[i];
            tags.push(tagPath);
        }
    }
    
    return tags;
}

function findDraftByPath(todayPath) {
    const searchTerm = `today_path: ${todayPath}`;
    const drafts = Draft.query(searchTerm, "all", ["today-sync"], [], "modified", true, false);
    
    for (const draft of drafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.today_path === todayPath) {
            return draft;
        }
    }
    
    return null;
}

function generatePathFromTags(draft) {
    const tags = draft.tags;
    
    let bestTag = null;
    for (const tag of tags) {
        if (tag.startsWith("notes/") && (!bestTag || tag.length > bestTag.length)) {
            bestTag = tag;
        }
    }
    
    if (!bestTag) {
        bestTag = "notes/daily";
    }
    
    const firstLine = draft.content.split('\n')[0];
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

// ============ SYNC FUNCTIONS ============

function pullFromToday() {
    const stats = { created: 0, updated: 0, skipped: 0 };
    
    // Fetch repository tree
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`;
    const treeRequest = {
        "url": url,
        "method": "GET",
        "headers": {
            "Authorization": `token ${config.token}`,
            "Accept": "application/vnd.github.v3+json"
        }
    };
    
    const http = HTTP.create();
    const treeResponse = http.request(treeRequest);
    
    if (!treeResponse.success) {
        throw new Error(`Failed to fetch repository: ${treeResponse.statusCode}`);
    }
    
    const tree = JSON.parse(treeResponse.responseText);
    const noteFiles = tree.tree.filter(item => 
        item.type === "blob" && 
        item.path.startsWith("notes/") && 
        item.path.endsWith(".md") &&
        !item.path.includes("/inbox/")
    );
    
    // Process each file
    for (const file of noteFiles) {
        // Fetch file content
        const fileUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${file.path}?ref=${config.branch}`;
        const fileRequest = {
            "url": fileUrl,
            "method": "GET",
            "headers": {
                "Authorization": `token ${config.token}`,
                "Accept": "application/vnd.github.v3+json"
            }
        };
        
        const fileResponse = http.request(fileRequest);
        if (!fileResponse.success) continue;
        
        const fileData = JSON.parse(fileResponse.responseText);
        const content = decodeBase64(fileData.content);
        
        // Check if draft exists
        let draft = findDraftByPath(file.path);
        
        if (draft) {
            const { metadata } = extractMetadata(draft.content);
            if (metadata.today_sha === fileData.sha) {
                stats.skipped++;
                continue;
            }
            
            // Update existing draft
            draft.content = addMetadata(content, {
                today_path: file.path,
                today_sha: fileData.sha,
                last_sync: new Date().toISOString(),
                sync_status: "synced"
            });
            draft.update();
            stats.updated++;
            
        } else {
            // Create new draft
            draft = Draft.create();
            draft.content = addMetadata(content, {
                today_path: file.path,
                today_sha: fileData.sha,
                last_sync: new Date().toISOString(),
                sync_status: "synced"
            });
            
            const tags = pathToTags(file.path);
            for (const tag of tags) {
                draft.addTag(tag);
            }
            
            draft.languageGrammar = "Markdown";
            draft.update();
            stats.created++;
        }
    }
    
    return stats;
}

function pushToToday() {
    const stats = { created: 0, updated: 0, skipped: 0 };
    
    // Query drafts to sync
    const drafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    for (const draft of drafts) {
        if (!draft.content || draft.content.trim().length === 0) {
            stats.skipped++;
            continue;
        }
        
        const { metadata, content: rawContent } = extractMetadata(draft.content);
        
        let todayPath = metadata.today_path;
        if (!todayPath) {
            todayPath = generatePathFromTags(draft);
        }
        
        // Check if file exists on Today server
        const checkUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${todayPath}?ref=${config.branch}`;
        const checkRequest = {
            "url": checkUrl,
            "method": "GET",
            "headers": {
                "Authorization": `token ${config.token}`,
                "Accept": "application/vnd.github.v3+json"
            }
        };
        
        const http = HTTP.create();
        const checkResponse = http.request(checkRequest);
        
        let existingFile = null;
        if (checkResponse.success) {
            existingFile = JSON.parse(checkResponse.responseText);
            
            // Check if content changed
            const remoteContent = decodeBase64(existingFile.content);
            if (remoteContent.trim() === rawContent.trim()) {
                stats.skipped++;
                continue;
            }
        }
        
        // Upload to Today server
        const uploadUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${todayPath}`;
        const requestBody = {
            "message": existingFile ? `Update ${todayPath} from Drafts` : `Create ${todayPath} from Drafts`,
            "content": encodeBase64(rawContent.trim()),
            "branch": config.branch
        };
        
        if (existingFile) {
            requestBody.sha = existingFile.sha;
        }
        
        const uploadRequest = {
            "url": uploadUrl,
            "method": "PUT",
            "data": requestBody,
            "headers": {
                "Authorization": `token ${config.token}`,
                "Accept": "application/vnd.github.v3+json",
                "Content-Type": "application/json"
            }
        };
        
        const uploadResponse = http.request(uploadRequest);
        
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
            } else {
                stats.created++;
            }
        }
    }
    
    return stats;
}

// ============ MAIN FUNCTION ============

function quickSync() {
    try {
        // Show progress
        app.displayInfoMessage("Starting sync...");
        
        // Pull from GitHub first
        console.log("Pulling from Today...");
        const pullStats = pullFromToday();
        
        // Brief pause
        wait(0.5);
        
        // Push to GitHub
        console.log("Pushing to Today...");
        const pushStats = pushToToday();
        
        // Create summary
        const summary = [
            "🔄 Quick Sync Complete",
            "",
            "**From GitHub:**",
            `  ✅ Created: ${pullStats.created}`,
            `  🔄 Updated: ${pullStats.updated}`,
            `  ⏭️ Skipped: ${pullStats.skipped}`,
            "",
            "**To GitHub:**",
            `  ✅ Created: ${pushStats.created}`,
            `  🔄 Updated: ${pushStats.updated}`,
            `  ⏭️ Skipped: ${pushStats.skipped}`,
            "",
            `Synced at: ${new Date().toLocaleTimeString()}`
        ].join('\n');
        
        // Update or create summary draft
        let summaryDraft = Draft.query("title:Quick Sync Summary", "inbox", [], [], "modified", true, false)[0];
        if (!summaryDraft) {
            summaryDraft = Draft.create();
        }
        
        summaryDraft.content = summary;
        summaryDraft.update();
        
        // Show success
        const totalChanges = pullStats.created + pullStats.updated + pushStats.created + pushStats.updated;
        if (totalChanges > 0) {
            app.displaySuccessMessage(`Synced ${totalChanges} changes`);
        } else {
            app.displaySuccessMessage("Everything up to date!");
        }
        
        // Load summary if there were changes
        if (totalChanges > 0) {
            editor.load(summaryDraft);
        }
        
    } catch (error) {
        app.displayErrorMessage(`Sync failed: ${error.message}`);
        console.log(error);
        context.fail(error.message);
    }
}

// Helper function for delays
function wait(seconds) {
    const start = Date.now();
    while (Date.now() - start < seconds * 1000) {
        // Wait
    }
}

// Run the sync
quickSync();
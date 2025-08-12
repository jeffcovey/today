// Drafts Action: Sync from Today
// Pulls all notes from Today app into Drafts
// 
// Setup:
// 1. Create a GitHub Personal Access Token at https://github.com/settings/tokens
//    - Needs 'repo' scope
// 2. In Drafts, create a new Action called "Sync from Today"
// 3. Add a "Script" step and paste this code
// 4. Update the configuration or use Drafts Credentials

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

// Convert Today path to Drafts tags
function pathToTags(path) {
    const tags = ["today-sync"];
    
    // Add hierarchical tags for the path
    // e.g., "notes/daily/file.md" → ["today-sync", "notes", "notes/daily"]
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

// Extract metadata from draft content (now at bottom)
function extractMetadata(content) {
    // Check for metadata at the bottom with clear separator
    const bottomMetadataRegex = /\n\n<!-- sync-metadata -->\n---\n([\s\S]*?)\n---$/;
    let match = content.match(bottomMetadataRegex);
    
    if (match) {
        // Found metadata at bottom
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

// Add or update metadata in content (now at bottom)
function addMetadata(content, metadata) {
    const metadataText = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    
    // Add metadata at the bottom with clear separator
    return `${content.trim()}\n\n<!-- sync-metadata -->\n---\n${metadataText}\n---`;
}

// Find draft by Today path
function findDraftByPath(todayPath) {
    // Search for drafts with the today_path in metadata
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

// Decode base64 content from GitHub
function decodeBase64(str) {
    // Drafts doesn't have atob, so we use a workaround
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

// ============ MAIN SYNC FUNCTION ============

function syncFromToday() {
    const stats = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0
    };
    
    console.log("Starting Today sync...");
    
    try {
        // Fetch the notes directory structure
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
            throw new Error(`Failed to fetch repository tree: ${treeResponse.statusCode}`);
        }
        
        const tree = JSON.parse(treeResponse.responseText);
        const noteFiles = tree.tree.filter(item => 
            item.type === "blob" && 
            item.path.startsWith("notes/") && 
            item.path.endsWith(".md")
        );
        
        console.log(`Found ${noteFiles.length} note files to sync`);
        
        // Process each file
        for (const file of noteFiles) {
            try {
                console.log(`Processing: ${file.path}`);
                
                // Skip inbox files (they're temporary)
                if (file.path.includes("/inbox/")) {
                    console.log("  Skipping inbox file");
                    stats.skipped++;
                    continue;
                }
                
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
                if (!fileResponse.success) {
                    console.log(`  Error fetching file: ${fileResponse.statusCode}`);
                    stats.errors++;
                    continue;
                }
                
                const fileData = JSON.parse(fileResponse.responseText);
                const content = decodeBase64(fileData.content);
                
                // Check if draft already exists
                let draft = findDraftByPath(file.path);
                
                if (draft) {
                    // Update existing draft
                    const { metadata: existingMetadata } = extractMetadata(draft.content);
                    
                    // Check if Today version is newer
                    if (existingMetadata.today_sha === fileData.sha) {
                        console.log("  Draft is up to date");
                        stats.skipped++;
                        continue;
                    }
                    
                    // Update the draft
                    const newMetadata = {
                        today_path: file.path,
                        today_sha: fileData.sha,
                        last_sync: new Date().toISOString(),
                        sync_status: "synced"
                    };
                    
                    draft.content = addMetadata(content, newMetadata);
                    draft.update();
                    console.log("  Updated existing draft");
                    stats.updated++;
                    
                } else {
                    // Create new draft
                    draft = Draft.create();
                    
                    const metadata = {
                        today_path: file.path,
                        today_sha: fileData.sha,
                        last_sync: new Date().toISOString(),
                        sync_status: "synced"
                    };
                    
                    draft.content = addMetadata(content, metadata);
                    
                    // Add tags
                    const tags = pathToTags(file.path);
                    for (const tag of tags) {
                        draft.addTag(tag);
                    }
                    
                    // Set draft properties
                    draft.languageGrammar = "Markdown";
                    
                    // Save the draft
                    draft.update();
                    console.log("  Created new draft");
                    stats.created++;
                }
                
            } catch (error) {
                console.log(`  Error processing ${file.path}: ${error.message}`);
                stats.errors++;
            }
        }
        
        // Create sync summary
        const summary = `Today Sync Complete\n\n` +
            `✅ Created: ${stats.created} drafts\n` +
            `🔄 Updated: ${stats.updated} drafts\n` +
            `⏭️ Skipped: ${stats.skipped} drafts\n` +
            `❌ Errors: ${stats.errors}\n\n` +
            `Total files processed: ${noteFiles.length}`;
        
        // Create or update sync status draft
        let statusDraft = Draft.query("title:Today Sync Status", "all", ["today-sync-status"], [], "modified", true, false)[0];
        if (!statusDraft) {
            statusDraft = Draft.create();
            statusDraft.addTag("today-sync-status");
        }
        
        statusDraft.content = `# Today Sync Status\n\n${summary}\n\nLast sync: ${new Date().toLocaleString()}`;
        statusDraft.update();
        
        // Show success message
        app.displaySuccessMessage(`Sync complete: ${stats.created} new, ${stats.updated} updated`);
        
        // Load the status draft to show results
        editor.load(statusDraft);
        
    } catch (error) {
        app.displayErrorMessage(`Sync failed: ${error.message}`);
        console.log(error);
        context.fail(error.message);
    }
}

// Run the sync
syncFromToday();
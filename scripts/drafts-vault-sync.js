// Vault Sync for Drafts
// Syncs drafts with your Today droplet's vault via the Vault API
//
// Setup:
// 1. In Drafts, create a new Action called "Vault Sync"
// 2. Add a "Script" step and paste this entire code
// 3. Run the action and enter your droplet API key when prompted
// 4. The script will show a menu to choose sync operation

// ============ CONFIGURATION ============
const CONFIG = {
    // Droplet API settings - UPDATE THIS TO YOUR DOMAIN
    dropletUrl: 'https://your-domain.example.com/api',  // Your droplet URL
    vaultApiKey: null,   // Will be set from credentials

    lastSyncKey: 'today_vault_sync_last_timestamp' // Key for storing last sync time
};

// ============ CREDENTIAL SETUP ============
function setupCredentials() {
    const credential = Credential.create("Today Vault Sync", "Configure droplet access");
    credential.addPasswordField("vaultApiKey", "Droplet API Key");

    if (!credential.authorize()) {
        return false;
    }

    CONFIG.vaultApiKey = credential.getValue("vaultApiKey");
    if (!CONFIG.vaultApiKey || CONFIG.vaultApiKey.trim() === '') {
        app.displayErrorMessage("API Key is required");
        return false;
    }

    return true;
}

// ============ COMMON HELPER FUNCTIONS ============

// Get last sync timestamp from a special sync state draft
function getLastSyncTime() {
    // Look for a special draft that stores sync state
    const stateDrafts = Draft.query("# Vault Sync State", "all", ["vault-sync-state"], [], "modified", true, false);
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
    let stateDrafts = Draft.query("# Vault Sync State", "all", ["vault-sync-state"], [], "modified", true, false);
    let stateDraft;

    if (stateDrafts && stateDrafts.length > 0) {
        stateDraft = stateDrafts[0];
    } else {
        // Create new sync state draft
        stateDraft = Draft.create();
        stateDraft.addTag("vault-sync-state");
        stateDraft.addTag("vault-sync-meta");
    }

    // Update content with current timestamp
    stateDraft.content = `# Vault Sync State\n\nThis draft stores metadata for the Vault sync system.\n\nLast Sync: ${isoTime}\n\n---\n_Do not delete this draft - it's used for incremental sync tracking_`;
    stateDraft.update();
}

// Extract metadata from draft content
function extractMetadata(content) {
    if (!content) return { metadata: {}, content: '' };

    // Check for markdown comment format (invisible in preview)
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
        return { metadata, content: contentWithoutMetadata };
    }

    return { metadata: {}, content: content };
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
    tags.push('vault-sync');

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
    const syncDrafts = Draft.query("", "all", ["vault-sync"], [], "modified", false, false);

    for (const draft of syncDrafts) {
        const { metadata } = extractMetadata(draft.content);
        if (metadata.vault_path === path) {
            return draft;
        }
    }

    return null;
}

// ============ DROPLET API FUNCTIONS ============

// Fetch file list from droplet vault
function fetchVaultFileList() {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/vault/list`,
            "method": "GET",
            "headers": {
                "X-API-Key": CONFIG.vaultApiKey,
                "Accept": "application/json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            timeout: 30
        });

        if (response.success) {
            const data = JSON.parse(response.responseText);
            return data.files || [];
        } else {
            console.log(`Failed to fetch vault file list: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching vault file list: ${error}`);
        return null;
    }
}

// Fetch single file from vault
function fetchVaultFile(path) {
    try {
        // Remove 'vault/' prefix if present
        const cleanPath = path.replace(/^vault\//, '');

        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/vault/file/${encodeURIComponent(cleanPath)}`,
            "method": "GET",
            "headers": {
                "X-API-Key": CONFIG.vaultApiKey,
                "Accept": "application/json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            timeout: 30
        });

        if (response.success) {
            const data = JSON.parse(response.responseText);
            // Decode Base64 content
            const content = Base64.decode(data.content);

            return {
                exists: true,
                content: content,
                sha: data.sha,
                lastModified: data.modified || new Date().toISOString()
            };
        } else if (response.statusCode === 404) {
            return { exists: false };
        } else {
            console.log(`Failed to fetch vault file ${path}: ${response.statusCode} ${response.error}`);
            return null;
        }
    } catch (error) {
        console.log(`Error fetching vault file ${path}: ${error}`);
        return null;
    }
}

// Upload file to vault inbox (since we can't update existing files directly)
function uploadToInbox(content, filename) {
    try {
        const http = HTTP.create();
        const response = http.request({
            "url": `${CONFIG.dropletUrl}/inbox/upload`,
            "method": "POST",
            "headers": {
                "X-API-Key": CONFIG.vaultApiKey,
                "Content-Type": "application/json",
                "User-Agent": "Drafts-Vault-Sync"
            },
            "data": {
                "content": content,
                "filename": filename
            },
            timeout: 30
        });

        if (response.success) {
            const data = JSON.parse(response.responseText);
            return { success: true, path: data.path };
        } else {
            console.log(`Failed to upload to inbox: ${response.statusCode} ${response.responseText}`);
            return { success: false, error: response.statusCode };
        }
    } catch (error) {
        console.log(`Error uploading to inbox: ${error}`);
        return { success: false, error: error.message };
    }
}

// ============ SYNC FUNCTIONS ============

// Pull from vault to Drafts
function pullFromVault(incrementalSync = true) {
    const stats = { created: 0, updated: 0, deleted: 0, errors: 0 };

    console.log(`${incrementalSync ? "Incremental" : "Full"} pull from vault...`);

    // Fetch files from vault
    console.log("Fetching files from vault...");
    const vaultFiles = fetchVaultFileList();

    if (!vaultFiles || vaultFiles.length === 0) {
        throw new Error("Failed to fetch files from vault or vault is empty");
    }

    console.log(`Found ${vaultFiles.length} files in vault`);

    for (const file of vaultFiles) {
        try {
            // Find existing draft
            let draft = findDraftByPath(file.path);

            // Skip if SHA hasn't changed (for incremental sync)
            if (incrementalSync && draft) {
                const { metadata } = extractMetadata(draft.content);
                if (metadata.vault_sha === file.sha) {
                    continue; // File unchanged, skip
                }
            }

            // Fetch file content
            const fileData = fetchVaultFile(file.path);

            if (!fileData || !fileData.exists) {
                stats.errors++;
                continue;
            }

            if (draft) {
                // Update existing draft
                draft.content = updateMetadata(fileData.content, {
                    vault_path: file.path,
                    vault_sha: fileData.sha || file.sha,
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
                    vault_path: file.path,
                    vault_sha: fileData.sha || file.sha,
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

// Push from Drafts to vault inbox (since we can't update existing files)
function pushToVault(onlyModified = true) {
    const stats = { uploaded: 0, errors: 0 };

    console.log(`${onlyModified ? "Modified" : "All"} drafts upload to inbox...`);

    // Get all sync-enabled drafts
    const syncDrafts = Draft.query("", "all", ["vault-sync"], [], "modified", false, false);
    console.log(`Found ${syncDrafts.length} sync-enabled drafts`);

    // Upload new/modified drafts to inbox
    for (const draft of syncDrafts) {
        try {
            const { metadata, content } = extractMetadata(draft.content);

            if (onlyModified) {
                // Skip if not modified since last sync
                if (metadata.sync_status === "synced") {
                    continue;
                }
            }

            // Generate filename for inbox
            const lines = content.split('\n');
            const title = lines[0].replace(/^#\s*/, '').trim() || 'Untitled';
            const date = new Date();
            const dateStr = date.toISOString().split('T')[0];
            const timeStr = date.toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
            const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
            const filename = `drafts-${dateStr}-${timeStr}-${titleSlug || 'untitled'}.md`;

            // Upload to inbox
            const uploadResult = uploadToInbox(content, filename);

            if (uploadResult.success) {
                // Update draft with sync metadata
                draft.content = updateMetadata(content, {
                    vault_inbox_path: uploadResult.path,
                    last_sync: new Date().toISOString(),
                    sync_status: "uploaded-to-inbox"
                });
                draft.update();

                stats.uploaded++;
                console.log(`Uploaded to inbox: ${filename}`);
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
prompt.title = "Vault Sync";
prompt.message = "Sync with Today droplet vault";
prompt.addButton("📥 Pull from Vault", "pull");
prompt.addButton("📤 Upload to Inbox", "push");
prompt.addButton("🔄 Two-Way Sync", "sync");
prompt.addButton("📋 Status", "status");

if (prompt.show()) {
    try {
        const action = prompt.buttonPressed;

        if (action === "pull") {
            const stats = pullFromVault(true);
            app.displaySuccessMessage(`Pull complete!\n\n✅ Created: ${stats.created}\n📝 Updated: ${stats.updated}\n❌ Errors: ${stats.errors}`);

        } else if (action === "push") {
            const stats = pushToVault(true);
            app.displaySuccessMessage(`Upload complete!\n\n📤 Uploaded to inbox: ${stats.uploaded}\n❌ Errors: ${stats.errors}`);

        } else if (action === "sync") {
            const pullStats = pullFromVault(true);
            const pushStats = pushToVault(true);
            app.displaySuccessMessage(`Sync complete!\n\n📥 From vault: ${pullStats.created + pullStats.updated}\n📤 To inbox: ${pushStats.uploaded}\n❌ Errors: ${pullStats.errors + pushStats.errors}`);

        } else if (action === "status") {
            const lastSync = getLastSyncTime();
            const syncDrafts = Draft.query("", "all", ["vault-sync"], [], "modified", false, false);
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
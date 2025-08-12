// Drafts Action: Migrate Metadata to Bottom
// Moves metadata from top to bottom of all synced drafts
//
// Setup:
// 1. In Drafts, create a new Action called "Migrate Metadata"
// 2. Add a "Script" step and paste this code

// Extract metadata from draft content (handles both positions)
function extractMetadata(content) {
    // Check for metadata at the bottom with clear separator
    const bottomMetadataRegex = /\n\n<!-- sync-metadata -->\n---\n([\s\S]*?)\n---$/;
    let match = content.match(bottomMetadataRegex);
    
    if (match) {
        // Already at bottom, extract it
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
        return { metadata, content: contentWithoutMetadata, position: 'bottom' };
    }
    
    // Check for metadata at top (legacy position)
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
        return { metadata, content: contentWithoutMetadata, position: 'top' };
    }
    
    return { metadata: {}, content: content, position: 'none' };
}

// Add metadata at the bottom
function addMetadataAtBottom(content, metadata) {
    const metadataText = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    
    // Add metadata at the bottom with clear separator
    return `${content.trim()}\n\n<!-- sync-metadata -->\n---\n${metadataText}\n---`;
}

function migrateMetadata() {
    // Get all drafts with today-sync tag
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    console.log(`Found ${syncDrafts.length} drafts with today-sync tag`);
    
    let migrated = 0;
    let alreadyAtBottom = 0;
    let noMetadata = 0;
    
    for (const draft of syncDrafts) {
        const { metadata, content, position } = extractMetadata(draft.content);
        
        if (position === 'bottom') {
            alreadyAtBottom++;
            console.log(`  Draft already has metadata at bottom`);
        } else if (position === 'top') {
            // Migrate from top to bottom
            draft.content = addMetadataAtBottom(content, metadata);
            draft.update();
            migrated++;
            console.log(`  Migrated metadata to bottom`);
        } else {
            noMetadata++;
            console.log(`  Draft has no metadata`);
        }
    }
    
    // Create migration report
    const report = [
        "# 📦 Metadata Migration Complete",
        "",
        `**Total drafts processed:** ${syncDrafts.length}`,
        "",
        `✅ **Migrated to bottom:** ${migrated}`,
        `📍 **Already at bottom:** ${alreadyAtBottom}`,
        `⚠️ **No metadata found:** ${noMetadata}`,
        "",
        "## What Changed?",
        "",
        "Metadata has been moved from the top of drafts to the bottom,",
        "with a clear HTML comment separator. This makes your notes",
        "cleaner and easier to read, with sync information hidden at",
        "the end of each draft.",
        "",
        "The metadata is now marked with:",
        "```",
        "<!-- sync-metadata -->",
        "---",
        "today_path: ...",
        "today_sha: ...",
        "---",
        "```",
        "",
        `*Migrated at: ${new Date().toLocaleString()}*`
    ].join('\n');
    
    // Create or update report draft
    let reportDraft = Draft.query("title:Metadata Migration Complete", "inbox", [], [], "modified", true, false)[0];
    if (!reportDraft) {
        reportDraft = Draft.create();
    }
    
    reportDraft.content = report;
    reportDraft.update();
    
    // Show results
    if (migrated > 0) {
        app.displaySuccessMessage(`Migrated ${migrated} drafts to bottom metadata`);
    } else {
        app.displayInfoMessage("No drafts needed migration");
    }
    
    editor.load(reportDraft);
}

// Run migration
migrateMetadata();
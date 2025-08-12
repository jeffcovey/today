// Drafts Action: Sync Status Dashboard
// Shows the current sync status and allows manual conflict resolution
// 
// Setup:
// 1. In Drafts, create a new Action called "Sync Status"
// 2. Add a "Script" step and paste this code

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

// Format date for display
function formatDate(dateStr) {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    return `${diffDays} days ago`;
}

// ============ MAIN FUNCTION ============

function showSyncStatus() {
    console.log("Analyzing sync status...");
    
    // Query all drafts with today-sync tag
    const syncedDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    // Categorize drafts
    const stats = {
        total: syncedDrafts.length,
        synced: 0,
        pending: 0,
        errors: 0,
        noPath: 0,
        recentSync: 0
    };
    
    const pendingDrafts = [];
    const errorDrafts = [];
    const noPathDrafts = [];
    
    const now = new Date();
    const recentThreshold = 24 * 60 * 60 * 1000; // 24 hours
    
    for (const draft of syncedDrafts) {
        const { metadata } = extractMetadata(draft.content);
        
        if (!metadata.today_path) {
            stats.noPath++;
            noPathDrafts.push(draft);
        } else if (draft.tags.includes("sync-error")) {
            stats.errors++;
            errorDrafts.push(draft);
        } else if (metadata.sync_status === "synced") {
            stats.synced++;
            
            // Check if recently synced
            if (metadata.last_sync) {
                const syncDate = new Date(metadata.last_sync);
                if (now - syncDate < recentThreshold) {
                    stats.recentSync++;
                }
            }
        } else {
            stats.pending++;
            pendingDrafts.push(draft);
        }
    }
    
    // Build status report
    let report = `# 📊 Today Sync Status\n\n`;
    report += `**Last checked:** ${new Date().toLocaleString()}\n\n`;
    
    // Overview
    report += `## Overview\n\n`;
    report += `- **Total synced drafts:** ${stats.total}\n`;
    report += `- **✅ Synced:** ${stats.synced} (${stats.recentSync} in last 24h)\n`;
    report += `- **⏳ Pending sync:** ${stats.pending}\n`;
    report += `- **❌ Sync errors:** ${stats.errors}\n`;
    report += `- **📝 No GitHub path:** ${stats.noPath}\n\n`;
    
    // Pending drafts
    if (pendingDrafts.length > 0) {
        report += `## ⏳ Pending Sync (${pendingDrafts.length})\n\n`;
        for (const draft of pendingDrafts.slice(0, 10)) {
            const firstLine = draft.content.split('\n')[0].substring(0, 50);
            const { metadata } = extractMetadata(draft.content);
            report += `- **${firstLine}**\n`;
            report += `  - Path: ${metadata.today_path || "Not set"}\n`;
            report += `  - Modified: ${formatDate(draft.modifiedAt)}\n\n`;
        }
        if (pendingDrafts.length > 10) {
            report += `*...and ${pendingDrafts.length - 10} more*\n\n`;
        }
    }
    
    // Error drafts
    if (errorDrafts.length > 0) {
        report += `## ❌ Sync Errors (${errorDrafts.length})\n\n`;
        for (const draft of errorDrafts.slice(0, 5)) {
            const firstLine = draft.content.split('\n')[0].substring(0, 50);
            const { metadata } = extractMetadata(draft.content);
            report += `- **${firstLine}**\n`;
            report += `  - Path: ${metadata.today_path || "Not set"}\n`;
            report += `  - Last attempt: ${formatDate(metadata.last_sync)}\n\n`;
        }
        if (errorDrafts.length > 5) {
            report += `*...and ${errorDrafts.length - 5} more*\n\n`;
        }
    }
    
    // Drafts without GitHub path
    if (noPathDrafts.length > 0) {
        report += `## 📝 No GitHub Path (${noPathDrafts.length})\n\n`;
        report += `These drafts need a GitHub path assigned:\n\n`;
        for (const draft of noPathDrafts.slice(0, 5)) {
            const firstLine = draft.content.split('\n')[0].substring(0, 50);
            const tags = draft.tags.filter(t => t.startsWith("notes/")).join(", ");
            report += `- **${firstLine}**\n`;
            report += `  - Tags: ${tags || "None"}\n`;
            report += `  - Created: ${formatDate(draft.createdAt)}\n\n`;
        }
        if (noPathDrafts.length > 5) {
            report += `*...and ${noPathDrafts.length - 5} more*\n\n`;
        }
    }
    
    // Actions section
    report += `## 🔧 Actions\n\n`;
    report += `To sync changes:\n`;
    report += `1. Run "**Sync from GitHub**" to pull latest changes\n`;
    report += `2. Run "**Sync to GitHub**" to push your changes\n\n`;
    
    if (stats.errors > 0) {
        report += `To fix sync errors:\n`;
        report += `1. Review error drafts above\n`;
        report += `2. Remove "sync-error" tag after fixing\n`;
        report += `3. Run "Sync to GitHub" again\n\n`;
    }
    
    if (stats.noPath > 0) {
        report += `To assign GitHub paths:\n`;
        report += `1. Add appropriate "notes/*" tags to drafts\n`;
        report += `2. Run "Sync to GitHub" to auto-generate paths\n\n`;
    }
    
    // Workspace info
    report += `## 📁 Workspace Organization\n\n`;
    report += `Your notes are organized with these tags:\n`;
    report += `- **notes/daily** - Daily journal entries\n`;
    report += `- **notes/tasks** - Task lists and todos\n`;
    report += `- **notes/concerns** - Concerns and worries\n`;
    report += `- **notes/reviews** - Daily review files\n`;
    report += `- **notes/ogm-work** - OlderGay.Men work items\n\n`;
    
    // Create or update status draft
    let statusDraft = Draft.query("title:Today Sync Status", "all", ["today-sync-status"], [], "modified", true, false)[0];
    if (!statusDraft) {
        statusDraft = Draft.create();
        statusDraft.addTag("today-sync-status");
    }
    
    statusDraft.content = report;
    statusDraft.update();
    
    // Load the status draft
    editor.load(statusDraft);
    
    // Show summary message
    if (stats.errors > 0) {
        app.displayWarningMessage(`${stats.errors} sync errors need attention`);
    } else if (stats.pending > 0) {
        app.displayInfoMessage(`${stats.pending} drafts pending sync`);
    } else {
        app.displaySuccessMessage(`All ${stats.synced} drafts are synced!`);
    }
}

// Run the status check
showSyncStatus();
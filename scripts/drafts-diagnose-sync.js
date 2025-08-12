// Drafts Action: Diagnose Sync Issues
// Checks drafts for sync problems and provides detailed report
//
// Setup:
// 1. In Drafts, create a new Action called "Diagnose Sync"
// 2. Add a "Script" step and paste this code

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

function diagnoseSyncIssues() {
    // Get all drafts with today-sync tag
    const syncDrafts = Draft.query("", "all", ["today-sync"], [], "modified", false, false);
    
    console.log(`Found ${syncDrafts.length} drafts with today-sync tag`);
    
    const issues = {
        noMetadata: [],
        noPath: [],
        noSha: [],
        hasError: [],
        healthy: []
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
            metadata: metadata
        };
        
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
    
    // Build diagnostic report
    let report = `# 🔍 Sync Diagnostics Report\n\n`;
    report += `**Total drafts:** ${syncDrafts.length}\n`;
    report += `**Healthy:** ${issues.healthy.length}\n`;
    report += `**Issues found:** ${syncDrafts.length - issues.healthy.length}\n\n`;
    
    if (issues.hasError.length > 0) {
        report += `## ❌ Drafts with Sync Errors (${issues.hasError.length})\n\n`;
        for (const draft of issues.hasError) {
            report += `- **${draft.title}**\n`;
            report += `  - Path: ${draft.metadata.today_path || "missing"}\n`;
            report += `  - Tags: ${draft.tags}\n\n`;
        }
    }
    
    if (issues.noMetadata.length > 0) {
        report += `## ⚠️ Drafts Without Metadata (${issues.noMetadata.length})\n\n`;
        report += `These drafts need metadata added:\n\n`;
        for (const draft of issues.noMetadata) {
            report += `- **${draft.title}**\n`;
            report += `  - Tags: ${draft.tags}\n`;
            report += `  - Action: Will generate path from tags\n\n`;
        }
    }
    
    if (issues.noPath.length > 0) {
        report += `## 📁 Drafts Without Path (${issues.noPath.length})\n\n`;
        for (const draft of issues.noPath) {
            report += `- **${draft.title}**\n`;
            report += `  - Has metadata but missing today_path\n\n`;
        }
    }
    
    if (issues.noSha.length > 0) {
        report += `## 🔄 Drafts Without SHA (${issues.noSha.length})\n\n`;
        for (const draft of issues.noSha) {
            report += `- **${draft.title}**\n`;
            report += `  - Path: ${draft.metadata.today_path}\n`;
            report += `  - Needs sync to get SHA\n\n`;
        }
    }
    
    report += `## ✅ Healthy Drafts (${issues.healthy.length})\n\n`;
    if (issues.healthy.length > 0) {
        report += `These drafts have proper sync metadata:\n\n`;
        for (const draft of issues.healthy.slice(0, 5)) {
            report += `- **${draft.title}**\n`;
            report += `  - Path: ${draft.metadata.today_path}\n\n`;
        }
        if (issues.healthy.length > 5) {
            report += `*...and ${issues.healthy.length - 5} more*\n\n`;
        }
    }
    
    report += `## 🔧 Recommended Actions\n\n`;
    if (issues.hasError.length > 0) {
        report += `1. Run "Clear Sync Errors" action\n`;
    }
    if (issues.noMetadata.length > 0) {
        report += `2. Run "Sync to Today" - it will auto-generate paths\n`;
    }
    report += `3. Run "Quick Sync" to sync all changes\n\n`;
    
    report += `*Generated: ${new Date().toLocaleString()}*`;
    
    // Create or update diagnostic draft
    let diagDraft = Draft.query("title:Sync Diagnostics Report", "inbox", [], [], "modified", true, false)[0];
    if (!diagDraft) {
        diagDraft = Draft.create();
    }
    
    diagDraft.content = report;
    diagDraft.update();
    
    // Show report
    editor.load(diagDraft);
    
    const totalIssues = syncDrafts.length - issues.healthy.length;
    if (totalIssues > 0) {
        app.displayWarningMessage(`Found ${totalIssues} sync issues - see report`);
    } else {
        app.displaySuccessMessage("All drafts are healthy!");
    }
}

// Run diagnostics
diagnoseSyncIssues();
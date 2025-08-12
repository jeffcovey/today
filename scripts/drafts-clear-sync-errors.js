// Drafts Action: Clear Sync Errors
// Removes sync-error tags from all drafts to allow retry
//
// Setup:
// 1. In Drafts, create a new Action called "Clear Sync Errors"
// 2. Add a "Script" step and paste this code

function clearSyncErrors() {
    // Find all drafts with sync-error tag
    const errorDrafts = Draft.query("", "all", ["sync-error"], [], "modified", false, false);
    
    console.log(`Found ${errorDrafts.length} drafts with sync errors`);
    
    let cleared = 0;
    for (const draft of errorDrafts) {
        // Remove the sync-error tag
        draft.removeTag("sync-error");
        draft.update();
        cleared++;
        console.log(`Cleared error from draft: ${draft.displayTitle}`);
    }
    
    // Create report
    const report = [
        "# 🧹 Sync Errors Cleared",
        "",
        `✅ Cleared errors from ${cleared} drafts`,
        "",
        "These drafts are now ready to sync again.",
        "Run 'Quick Sync' or 'Sync to Today' to retry.",
        "",
        `Cleared at: ${new Date().toLocaleString()}`
    ].join('\n');
    
    // Create or update report draft
    let reportDraft = Draft.query("title:Sync Errors Cleared", "inbox", [], [], "modified", true, false)[0];
    if (!reportDraft) {
        reportDraft = Draft.create();
    }
    
    reportDraft.content = report;
    reportDraft.update();
    
    // Show success
    if (cleared > 0) {
        app.displaySuccessMessage(`Cleared ${cleared} sync errors`);
        editor.load(reportDraft);
    } else {
        app.displayInfoMessage("No sync errors to clear");
    }
}

// Run the function
clearSyncErrors();
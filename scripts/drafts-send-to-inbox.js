// Drafts Action: Send to Today Inbox
// This script uploads a draft directly to your droplet's inbox
// 
// Setup:
// 1. In Drafts, create a new Action
// 2. Add a "Script" step and paste this code
// 3. Run the action and enter your droplet API key when prompted

// ============ CONFIGURATION ============
const config = {
    dropletUrl: 'https://today.jeffcovey.net/api/inbox/upload'  // Your droplet URL
};

// Use Drafts Credential for secure token storage
const credential = Credential.create("Today Inbox", "Configure droplet API key");
credential.addPasswordField("dropletApiKey", "Droplet API Key");
if (!credential.authorize()) {
    context.fail("Credentials required");
}
config.dropletApiKey = credential.getValue("dropletApiKey");

// ============ MAIN SCRIPT ============

// Get draft content and metadata
let content = editor.getText();
const lines = content.split('\n');
const title = lines[0].replace(/^#\s*/, '').trim() || 'Untitled';

// Generate filename with UTC timestamp to avoid timezone issues
const date = new Date();
// Use UTC timestamp in filename for consistency
const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
const timeStr = date.toISOString().split('T')[1].split('.')[0].replace(/:/g, ''); // HHMMSS
const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
const filename = `${dateStr}-${timeStr}-UTC-${titleSlug || 'untitled'}.md`;

// Function to upload to droplet
function uploadToDroplet() {
    const dropletRequest = {
        "url": config.dropletUrl,
        "method": "POST",
        "data": {
            "content": content,
            "filename": filename
        },
        "headers": {
            "X-API-Key": config.dropletApiKey,
            "Content-Type": "application/json",
            "User-Agent": "Drafts-Today-Inbox"
        }
    };
    
    console.log(`Attempting droplet upload to: ${config.dropletUrl}`);
    const response = HTTP.create().request(dropletRequest);
    
    if (response.success) {
        console.log("Droplet upload successful");
        return { success: true, method: 'droplet' };
    } else {
        console.log(`Droplet upload failed: ${response.statusCode} - ${response.responseText}`);
        return { success: false, error: response.statusCode };
    }
}

// Upload to droplet
const result = uploadToDroplet();

// Handle result
if (result.success) {
    app.displaySuccessMessage(`Note uploaded: ${filename}`);
    
    // Add a tag to track uploaded drafts
    draft.addTag("uploaded-to-inbox");
    draft.update();
    
    // Optional: Archive the draft after successful upload
    // draft.isArchived = true;
    // draft.update();
} else {
    app.displayErrorMessage(`Failed to upload to droplet: ${result.error || 'Unknown error'}`);
    console.log(`Upload failed`);
    context.fail();
}
// Drafts Action: Send to Today Inbox
// This script uploads a draft directly to your server's inbox API
//
// Setup in Drafts app (iOS/Mac):
// 1. Create a new Action
// 2. Add a "Script" step and paste this code
// 3. Update the inboxUrl to your server's domain
// 4. Run the action and enter your API key when prompted
//
// The API key is stored securely in Drafts' credential system.
// Your server must have the inbox-api service running.

// ============ CONFIGURATION ============
const config = {
    // UPDATE THIS TO YOUR DOMAIN
    inboxUrl: 'https://your-domain.example.com/api/inbox/upload'
};

// Use Drafts Credential for secure token storage
const credential = Credential.create("Today Inbox", "Configure inbox API key");
credential.addPasswordField("inboxApiKey", "Inbox API Key");
if (!credential.authorize()) {
    context.fail("Credentials required");
}
config.inboxApiKey = credential.getValue("inboxApiKey");

// ============ MAIN SCRIPT ============

// Get draft content and metadata
let content = editor.getText();
const lines = content.split('\n');
const title = lines[0].replace(/^#\s*/, '').trim() || 'Untitled';

// Generate filename with UTC timestamp to avoid timezone issues
const date = new Date();
const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
const timeStr = date.toISOString().split('T')[1].split('.')[0].replace(/:/g, ''); // HHMMSS
const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
const filename = `${dateStr}-${timeStr}-UTC-${titleSlug || 'untitled'}.md`;

// Function to upload to server
function uploadToServer() {
    const request = {
        "url": config.inboxUrl,
        "method": "POST",
        "data": {
            "content": content,
            "filename": filename
        },
        "headers": {
            "X-API-Key": config.inboxApiKey,
            "Content-Type": "application/json",
            "User-Agent": "Drafts-Today-Inbox"
        }
    };

    console.log(`Uploading to: ${config.inboxUrl}`);
    const response = HTTP.create().request(request);

    if (response.success) {
        console.log("Upload successful");
        return { success: true };
    } else {
        console.log(`Upload failed: ${response.statusCode} - ${response.responseText}`);
        return { success: false, error: response.statusCode };
    }
}

// Upload to server
const result = uploadToServer();

// Handle result
if (result.success) {
    app.displaySuccessMessage(`Uploaded: ${filename}`);

    // Add a tag to track uploaded drafts
    draft.addTag("uploaded-to-inbox");
    draft.update();

    // Optional: Archive the draft after successful upload
    // draft.isArchived = true;
    // draft.update();
} else {
    app.displayErrorMessage(`Upload failed: ${result.error || 'Unknown error'}`);
    console.log("Upload failed");
    context.fail();
}

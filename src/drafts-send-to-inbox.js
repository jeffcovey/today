// Drafts Action: Send to GitHub Notes
// This script uploads a draft directly to your GitHub repository's inbox
// 
// Setup:
// 1. Create a GitHub Personal Access Token at https://github.com/settings/tokens
//    - Needs 'repo' scope
// 2. In Drafts, create a new Action
// 3. Add a "Script" step and paste this code
// 4. Update the configuration below with your details

// ============ CONFIGURATION ============
const config = {
    // Droplet API (primary)
    dropletUrl: 'https://today.jeffcovey.net/api/inbox/upload',  // Your droplet URL
    
    // GitHub (fallback)
    owner: 'OlderGay-Men',  // Organization name
    repo: 'today',          // Repository name
    branch: 'main'
};

// Use Drafts Credential for secure token storage
// Store both API keys in the same credential
const credential = Credential.create("Today Inbox", "Configure upload credentials");
credential.addPasswordField("dropletApiKey", "Droplet API Key");
credential.addPasswordField("githubToken", "GitHub Token (fallback)");
if (!credential.authorize()) {
    context.fail("Credentials required");
}
config.dropletApiKey = credential.getValue("dropletApiKey");
config.githubToken = credential.getValue("githubToken");

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

// Function to upload to GitHub
function uploadToGitHub() {
    const filepath = `vault/notes/inbox/${filename}`;
    const commitMessage = `Upload from Drafts: ${title}`;
    const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filepath}`;
    
    // Check if file exists first
    let sha = null;
    const checkRequest = {
        "url": url,
        "method": "GET",
        "headers": {
            "Authorization": `Bearer ${config.githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Drafts-Today-Inbox"
        }
    };
    
    const checkResponse = HTTP.create().request(checkRequest);
    if (checkResponse.success) {
        const existing = JSON.parse(checkResponse.responseText);
        sha = existing.sha;
    }
    
    // Prepare the content (base64 encoded)
    const contentBase64 = Base64.encode(content);
    
    // Create or update file
    const requestBody = {
        "message": commitMessage,
        "content": contentBase64,
        "branch": config.branch
    };
    
    if (sha) {
        requestBody.sha = sha;
    }
    
    const request = {
        "url": url,
        "method": "PUT",
        "data": requestBody,
        "headers": {
            "Authorization": `Bearer ${config.githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Drafts-Today-Inbox"
        }
    };
    
    console.log("Attempting GitHub upload");
    const response = HTTP.create().request(request);
    
    if (response.success) {
        console.log("GitHub upload successful");
        return { success: true, method: 'github' };
    } else {
        console.log(`GitHub upload failed: ${response.statusCode}`);
        return { success: false, error: response.statusCode };
    }
}

// Try droplet first, then fallback to GitHub
let result = { success: false };

// Only try droplet if API key is configured
if (config.dropletApiKey && config.dropletApiKey.length > 0) {
    result = uploadToDroplet();
}

// If droplet failed or wasn't configured, try GitHub
if (!result.success && config.githubToken && config.githubToken.length > 0) {
    console.log("Falling back to GitHub upload");
    result = uploadToGitHub();
}

// Handle result
if (result.success) {
    const method = result.method === 'droplet' ? '📡 Droplet' : '🐙 GitHub';
    app.displaySuccessMessage(`Note uploaded via ${method}: ${filename}`);
    
    // Add a tag to track uploaded drafts
    draft.addTag("uploaded-to-inbox");
    draft.addTag(`uploaded-via-${result.method}`);
    draft.update();
    
    // Optional: Archive the draft after successful upload
    // draft.isArchived = true;
    // draft.update();
} else {
    app.displayErrorMessage(`Failed to upload to both droplet and GitHub`);
    console.log(`All upload methods failed`);
    context.fail();
}
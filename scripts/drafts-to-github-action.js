// Drafts Action: Send to GitHub Notes
// This script uploads a draft directly to your GitHub repository
// 
// Setup:
// 1. Create a GitHub Personal Access Token at https://github.com/settings/tokens
//    - Needs 'repo' scope
// 2. In Drafts, create a new Action
// 3. Add a "Script" step and paste this code
// 4. Update the configuration below with your details

// ============ CONFIGURATION ============
const config = {
    owner: 'OlderGay-Men',  // Organization name
    repo: 'notion-cli',
    token: 'YOUR_GITHUB_TOKEN', // Your personal access token (store in Drafts Credentials for security)
    branch: 'main',
    defaultPath: 'notes/daily/', // Default folder for notes
};

// Use Drafts Credential for secure token storage
// credential = Credential.create("GitHub Token", "Enter your GitHub Personal Access Token");
// credential.addPasswordField("token", "Token");
// if (!credential.authorize()) {
//     context.fail("GitHub credentials required");
// }
// config.token = credential.getValue("token");

// ============ MAIN SCRIPT ============

// Get draft content and metadata
const content = editor.getText();
const lines = content.split('\n');
const title = lines[0].replace(/^#\s*/, '').trim() || 'Untitled';
const tags = draft.tags || [];

// Determine file path based on content or tags
let folder = config.defaultPath;
if (content.includes('- [ ]') || content.includes('- [x]')) {
    folder = 'notes/tasks/';
} else if (tags.includes('idea')) {
    folder = 'notes/ideas/';
} else if (tags.includes('reference')) {
    folder = 'notes/reference/';
}

// Generate filename (date-based or title-based)
const date = new Date();
const dateStr = date.toISOString().split('T')[0];
const timestamp = date.toISOString().replace(/[:.]/g, '-');
const filename = `${dateStr}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
const filepath = `${folder}${filename}`;

// Prepare commit message
const commitMessage = `Add note: ${title}`;

// GitHub API request
const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filepath}`;

// Check if file exists first
let sha = null;
const checkRequest = {
    "url": url,
    "method": "GET",
    "headers": {
        "Authorization": `token ${config.token}`,
        "Accept": "application/vnd.github.v3+json"
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
        "Authorization": `token ${config.token}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
    }
};

const http = HTTP.create();
const response = http.request(request);

if (response.success) {
    app.displaySuccessMessage(`Note uploaded to ${filepath}`);
    
    // Optional: Archive the draft after successful upload
    // draft.isArchived = true;
    // draft.update();
} else {
    app.displayErrorMessage(`Failed to upload: ${response.statusCode}`);
    console.log(response.responseText);
    context.fail();
}
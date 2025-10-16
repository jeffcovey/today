// Drafts Action: Stop Time Tracking Timer
// This script reads the current-timer.md file and creates a time tracking note
//
// Setup:
// 1. In Drafts, create a new Action
// 2. Add a "Script" step and paste this code
// 3. The action will create a time tracking note from the current timer

// ============ CONFIGURATION ============
const config = {
    timerFilePath: '/Users/jeff/Library/Mobile Documents/com~apple~CloudDocs/vault/logs/time-tracking/current-timer.md',
    dropletUrl: 'https://today.jeffcovey.net/api/inbox/upload'
};

// Use Drafts Credential for secure token storage
const credential = Credential.create("Today Inbox", "Configure droplet API key");
credential.addPasswordField("dropletApiKey", "Droplet API Key");
if (!credential.authorize()) {
    context.fail("Credentials required");
}
config.dropletApiKey = credential.getValue("dropletApiKey");

// ============ MAIN SCRIPT ============

// Read the current timer file from iCloud Drive
const fm = FileManager.createCloud();

if (!fm.fileExists(config.timerFilePath)) {
    app.displayErrorMessage("No timer running");
    context.fail("No timer file found");
}

// Read timer file contents
const timerContent = fm.readString(config.timerFilePath);
const lines = timerContent.split('\n').filter(line => line.trim() !== '');

if (lines.length < 2) {
    app.displayErrorMessage("Invalid timer file format");
    context.fail("Timer file incomplete");
}

const description = lines[0];
const startTime = lines[1];

// Calculate duration
const start = new Date(startTime);
const end = new Date();

if (isNaN(start.getTime())) {
    app.displayErrorMessage("Invalid start time in timer");
    context.fail("Invalid timer start time");
}

const durationMinutes = Math.floor((end - start) / (1000 * 60));
const hours = Math.floor(durationMinutes / 60);
const minutes = durationMinutes % 60;

let durationStr;
if (hours > 0 && minutes > 0) {
    durationStr = `${hours}h${minutes}m`;
} else if (hours > 0) {
    durationStr = `${hours}h`;
} else {
    durationStr = `${minutes}m`;
}

// Create time tracking note content
const noteContent = `# Time Tracking

${description}

${durationStr}`;

// Generate filename with UTC timestamp
const dateStr = end.toISOString().split('T')[0]; // YYYY-MM-DD
const timeStr = end.toISOString().split('T')[1].split('.')[0].replace(/:/g, ''); // HHMMSS
const filename = `${dateStr}-${timeStr}-UTC-time-tracking.md`;

// Upload to droplet
function uploadToDroplet() {
    const dropletRequest = {
        "url": config.dropletUrl,
        "method": "POST",
        "data": {
            "content": noteContent,
            "filename": filename
        },
        "headers": {
            "X-API-Key": config.dropletApiKey,
            "Content-Type": "application/json",
            "User-Agent": "Drafts-Time-Tracking"
        }
    };

    console.log(`Uploading time tracking note to: ${config.dropletUrl}`);
    const response = HTTP.create().request(dropletRequest);

    if (response.success) {
        console.log("Upload successful");
        return { success: true };
    } else {
        console.log(`Upload failed: ${response.statusCode} - ${response.responseText}`);
        return { success: false, error: response.statusCode };
    }
}

// Upload the time tracking note
const result = uploadToDroplet();

if (result.success) {
    // Delete the timer file
    try {
        fm.remove(config.timerFilePath);
        console.log("Timer file deleted");
    } catch (e) {
        console.log("Warning: Could not delete timer file: " + e);
        // Don't fail, the upload succeeded
    }

    app.displaySuccessMessage(`Timer stopped: ${durationStr} - ${description}`);
} else {
    app.displayErrorMessage(`Failed to upload time tracking note: ${result.error || 'Unknown error'}`);
    console.log(`Upload failed`);
    context.fail();
}

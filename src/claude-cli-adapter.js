import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { colors } from './cli-utils.js';

const execAsync = promisify(exec);

export class ClaudeCLIAdapter {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'claude-email');
    // Try to create an API client as fallback
    this.fallbackClient = null;
    const apiKey = process.env.TODAY_ANTHROPIC_KEY;
    if (apiKey) {
      try {
        this.fallbackClient = new Anthropic({ apiKey });
      } catch (e) {
        // API client creation failed, will use CLI only
      }
    }
    this.cliTimeout = 30000; // 30 seconds default
  }

  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's ok
    }
  }

  async askClaude(systemPrompt, userQuery, options = {}) {
    // Try CLI first
    try {
      return await this.askClaudeCLI(systemPrompt, userQuery, options);
    } catch (cliError) {
      console.log(colors.yellow('Claude CLI failed, attempting API fallback...'));

      // Try API fallback if available
      if (this.fallbackClient) {
        try {
          return await this.askClaudeAPI(systemPrompt, userQuery, options);
        } catch (apiError) {
          console.error(colors.red('Both Claude CLI and API failed'));
          throw new Error(`Claude access failed: CLI: ${cliError.message}, API: ${apiError.message}`);
        }
      }

      // No fallback available
      throw cliError;
    }
  }

  async askClaudeAPI(systemPrompt, userQuery, options = {}) {
    if (!this.fallbackClient) {
      throw new Error('No API client available');
    }

    const response = await this.fallbackClient.messages.create({
      model: options.model || 'claude-3-haiku-20240307',
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature || 0,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userQuery }
      ]
    });

    return response.content[0].text;
  }

  async askClaudeCLI(systemPrompt, userQuery, options = {}) {
    // Combine system prompt and user query
    const fullPrompt = `${systemPrompt}

User Query: ${userQuery}

Please provide a concise, direct response.`;

    // Use spawn for better control
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      const claude = spawn('claude', [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timeout;

      // Set a timeout (use shorter timeout if we have API fallback)
      const timeoutDuration = this.fallbackClient ? 15000 : this.cliTimeout;
      timeout = setTimeout(() => {
        claude.kill('SIGTERM');
        reject(new Error(`Claude CLI timed out after ${timeoutDuration / 1000} seconds`));
      }, timeoutDuration);

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('error', (error) => {
        clearTimeout(timeout);
        console.error('Claude spawn error:', error);
        reject(new Error(`Failed to start claude CLI: ${error.message}`));
      });

      claude.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0 && code !== null) {
          console.error('Claude CLI exited with code:', code);
          console.error('stderr:', stderr);
          reject(new Error(`Claude CLI exited with code ${code}`));
        } else if (!stdout || stdout.trim().length === 0) {
          reject(new Error('Claude CLI returned empty response'));
        } else {
          resolve(stdout.trim());
        }
      });

      // Write the prompt to stdin
      claude.stdin.write(fullPrompt);
      claude.stdin.end();
    });
  }

  async filterWithClaude(items, query, itemType = 'emails') {
    const systemPrompt = `You are a smart filter for ${itemType}. The user will provide a natural language query and a list of items in JSON format.

Your response must be ONLY a valid JSON array containing the items that match the user's query. No other text, explanation, or formatting.

Examples:
- Query: "emails from github" → Return only emails where from_address contains "github"
- Query: "recent emails" → Return emails from the last few days
- Query: "unread emails" → Return emails where has_been_replied_to is false or 0

The items are provided below in JSON format.`;

    // Prepare the data
    const userPrompt = `Query: "${query}"

Items to filter:
${JSON.stringify(items, null, 2)}

Return ONLY the JSON array of matching items.`;

    try {
      const response = await this.askClaude(systemPrompt, userPrompt, {
        maxTokens: 4000,
        temperature: 0
      });

      // Try to extract JSON from the response
      try {
        // Look for JSON array in the response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
        // If no array found, try parsing the whole response
        return JSON.parse(response);
      } catch (parseError) {
        console.error('Failed to parse Claude response as JSON:', response.substring(0, 200));
        // Fall back to returning all items if parsing fails
        return items;
      }
    } catch (error) {
      console.error(colors.red('filterWithClaude failed:'), error.message);
      // Fall back to returning all items if Claude fails entirely
      return items;
    }
  }

  // Method to understand user intent
  async understandIntent(query, emailContext) {
    const systemPrompt = `You are an email management assistant. Analyze the user's query and determine what action they want to perform.

Respond with a JSON object containing:
{
  "intent": "search|delete|move|summarize|count|other",
  "filters": {
    "from": "email address or domain if mentioned",
    "subject": "subject keywords if mentioned",
    "date_range": "recent|today|yesterday|last_week|last_month|specific_date",
    "folder": "folder name if mentioned"
  },
  "action_details": "any additional details about the action"
}`;

    const response = await this.askClaude(systemPrompt, query);

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return JSON.parse(response);
    } catch (error) {
      // Default intent
      return {
        intent: 'search',
        filters: {},
        action_details: query
      };
    }
  }

  // Method to summarize emails
  async summarizeEmails(emails, options = {}) {
    const emailSummary = emails.map(e => ({
      from: e.from_address,
      subject: e.subject,
      date: e.date,
      preview: e.body_text ? e.body_text.substring(0, 200) : ''
    }));

    const systemPrompt = `You are an email summarizer. Provide a concise summary of the emails provided.

Focus on:
1. Key senders and topics
2. Any urgent or important items
3. Overall trends or patterns
4. Actionable items`;

    const userPrompt = `Please summarize these ${emails.length} emails:

${JSON.stringify(emailSummary, null, 2)}`;

    return await this.askClaude(systemPrompt, userPrompt);
  }
}
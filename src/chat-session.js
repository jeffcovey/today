/**
 * Chat Session - Manages conversation state and REPL loop
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { streamCompletion, getEffectiveContextLimit } from './ai-provider.js';
import {
  createChatInterface,
  prompt,
  writeStreamingResponse,
  displayMessage,
  displayHeader,
  displayHelp,
  displayError,
  displayInfo
} from './chat-ui.js';

// Reserve tokens for response (don't use full context for prompt)
const RESPONSE_TOKEN_RESERVE = 2000;

// Maximum lines to keep per data section in compact mode
const MAX_DATA_LINES_PER_SECTION = 30;

/**
 * Estimate token count from text (rough: ~4 chars per token)
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extract and write query instructions to a reference file
 * Returns the path to the file
 */
function writeReferenceFile(prompt) {
  const lines = prompt.split('\n');
  const instructions = [];
  let currentSource = '';
  let inSqlBlock = false;
  let collectingInstructions = false;

  for (const line of lines) {
    // Track source sections
    const sourceMatch = line.match(/## SOURCE: (.+)/);
    if (sourceMatch) {
      currentSource = sourceMatch[1];
      instructions.push(`\n## ${currentSource}\n`);
      collectingInstructions = true;
      continue;
    }

    // Track SQL blocks
    if (line.startsWith('```sql')) {
      inSqlBlock = true;
      instructions.push(line);
      continue;
    }
    if (line.startsWith('```') && inSqlBlock) {
      inSqlBlock = false;
      instructions.push(line);
      instructions.push('');
      continue;
    }
    if (inSqlBlock) {
      instructions.push(line);
      continue;
    }

    // Stop collecting at data section
    if (line.startsWith('**Data**')) {
      collectingInstructions = false;
      continue;
    }

    // Collect instruction lines
    if (collectingInstructions && currentSource) {
      if (line.startsWith('**To investigate') ||
          line.startsWith('Commands:') ||
          line.startsWith('SQL:') ||
          line.startsWith('Note:') ||
          line.startsWith('To find') ||
          line.startsWith('Common metric') ||
          line.startsWith('- ')) {
        instructions.push(line);
      }
    }
  }

  const content = `# Today Query Reference

This file contains instructions for querying more data from each source.
Use these commands when you need historical data or more details.

${instructions.join('\n')}
`;

  const refPath = join(process.cwd(), '.data', 'query-reference.md');
  try {
    writeFileSync(refPath, content);
    return refPath;
  } catch {
    return null;
  }
}

/**
 * Transform a verbose prompt into a compact format for limited context windows
 * - Strips markdown formatting and verbose instructions
 * - Truncates long data sections
 * - Keeps only essential data
 */
function compactifyPrompt(prompt, refFilePath) {
  const lines = prompt.split('\n');
  const compactLines = [];
  let inCodeBlock = false;
  let skipSection = false;
  let currentSection = '';
  let dataLineCount = 0;
  let truncatedSections = [];

  // Add reference file note at the start
  if (refFilePath) {
    compactLines.push(`[Query instructions in: ${refFilePath}]`);
    compactLines.push('');
  }

  for (const line of lines) {
    // Skip progress messages at the start
    if (line.match(/^[🔍📊⏳✅]/) || line.match(/^\s+⏳/)) {
      continue;
    }

    // Track code blocks
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        // Opening a code block
        inCodeBlock = true;
        dataLineCount = 0;

        // Skip SQL schema blocks entirely
        if (line.includes('sql') || currentSection.includes('schema')) {
          skipSection = true;
          continue;
        }
      } else {
        // Closing a code block
        inCodeBlock = false;
        if (dataLineCount >= MAX_DATA_LINES_PER_SECTION && currentSection) {
          truncatedSections.push(currentSection);
          compactLines.push(`  ... (truncated, use query commands for full data)`);
        }
        skipSection = false;
      }
      continue; // Skip the ``` markers
    }

    if (inCodeBlock && !skipSection) {
      dataLineCount++;
      // Truncate long data sections
      if (dataLineCount <= MAX_DATA_LINES_PER_SECTION) {
        compactLines.push(line);
      }
      continue;
    }

    if (skipSection) continue;

    // Track section headers
    if (line.startsWith('## ')) {
      currentSection = line;
      // Transform verbose headers to compact ones
      const match = line.match(/## SOURCE: (.+)/);
      if (match) {
        compactLines.push(`[${match[1]}]`);
      } else if (line.includes('Current') || line.includes('Pre-Computed')) {
        compactLines.push('[Now]');
      } else if (line.includes('Profile')) {
        compactLines.push('[Profile]');
      } else if (line.includes('Database')) {
        // Skip database section header
      } else if (line.includes('User Instructions')) {
        compactLines.push('[Instructions]');
      }
      continue;
    }

    // Skip ALL instruction/description lines (they're in the reference file now)
    if (line.startsWith('**') ||  // All bold headers
        line.startsWith('Run `') ||
        line.startsWith('- Run `') ||
        line.startsWith('The following') ||
        line.startsWith('Each section') ||
        line.includes('plugin system') ||
        // Plugin type descriptions (multi-line, can start mid-sentence)
        line.match(/^(Time logs|Diaries are|Issues are|Events may|Tasks are)/) ||
        line.match(/^(Habits are|Email messages|Projects involve|Health metrics)/) ||
        line.match(/^(They reflect|They may be|Each source|Use calendar)/) ||
        line.match(/^(Each task|Each entry|Use this data|Use habit_id)/) ||
        line.match(/^("On this day"|Some diary|Source-specific|Common metrics)/) ||
        line.match(/^(Commands:|SQL:|Note:|To find)/) ||
        // Continuation lines from multi-line descriptions
        line.match(/^(determinative|goal tracking|years\.|weather,|the user's)/) ||
        line.match(/^(a connection|They should|and availability|time or whether)/) ||
        line.match(/^(preparation\.|for work purposes|for understanding)/) ||
        line.match(/^(- State is|- Metadata contains|- Each source tracks)/)) {
      continue;
    }

    // Skip markdown formatting but keep content
    if (line.startsWith('# ')) {
      const content = line.replace(/^# /, '');
      if (content && !content.includes('Data Sources')) {
        compactLines.push(`[${content}]`);
      }
      continue;
    }

    // Skip separator lines
    if (line.match(/^[-=─━]+$/)) continue;

    // Skip empty lines in sequence
    if (!line.trim()) {
      if (compactLines.length > 0 && compactLines[compactLines.length - 1] !== '') {
        compactLines.push('');
      }
      continue;
    }

    // Keep data lines, but strip bold/quote markers
    let cleaned = line
      .replace(/^\*\*(.+?)\*\*:?/, '$1:')  // **bold** -> bold:
      .replace(/^> /, '')                   // > quote -> quote
      .replace(/\*\*/g, '')                 // remaining bold markers
      .trim();

    if (cleaned) {
      compactLines.push(cleaned);
    }
  }

  // Remove trailing empty lines
  while (compactLines.length > 0 && !compactLines[compactLines.length - 1]) {
    compactLines.pop();
  }

  return compactLines.join('\n');
}

// Export for use by bin/today --compact
export { compactifyPrompt, writeReferenceFile, estimateTokens };

/**
 * ChatSession manages conversation history and interactions
 */
export class ChatSession {
  constructor(systemPrompt, options = {}) {
    this.systemPrompt = systemPrompt;
    this.provider = options.provider || 'ollama';
    this.model = options.model || 'llama3.2';
    this.messages = [];
    this.refreshContextFn = options.refreshContextFn || null;
  }

  /**
   * Add a message to conversation history
   * @param {string} role - 'user' or 'assistant'
   * @param {string} content - Message content
   */
  addMessage(role, content) {
    this.messages.push({ role, content });
  }

  /**
   * Get messages formatted for AI provider
   * @returns {Array} Messages array
   */
  getMessages() {
    return this.messages.map(m => ({ role: m.role, content: m.content }));
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.messages = [];
  }

  /**
   * Process a slash command
   * @param {string} input - User input starting with /
   * @returns {object} { handled: boolean, action?: string }
   */
  processSlashCommand(input) {
    const cmd = input.toLowerCase().trim();

    switch (cmd) {
      case '/quit':
      case '/exit':
      case '/q':
        return { handled: true, action: 'quit' };

      case '/clear':
        this.clearHistory();
        displayInfo('Conversation cleared.');
        return { handled: true, action: 'continue' };

      case '/history':
        if (this.messages.length === 0) {
          displayInfo('No conversation history yet.');
        } else {
          console.log();
          for (const msg of this.messages) {
            displayMessage(msg.role, msg.content);
          }
        }
        return { handled: true, action: 'continue' };

      case '/model':
        displayInfo(`Provider: ${this.provider}, Model: ${this.model}`);
        return { handled: true, action: 'continue' };

      case '/context':
        return { handled: true, action: 'refresh_context' };

      case '/help':
      case '/?':
        displayHelp();
        return { handled: true, action: 'continue' };

      default:
        if (input.startsWith('/')) {
          displayError(`Unknown command: ${input}. Type /help for available commands.`);
          return { handled: true, action: 'continue' };
        }
        return { handled: false };
    }
  }

  /**
   * Send a message and stream the response
   * @param {string} userMessage - User's message
   * @returns {Promise<string>} - Assistant's response
   */
  async chat(userMessage) {
    // Add user message to history
    this.addMessage('user', userMessage);

    try {
      // Stream the completion
      // No system prompt needed - the initial context is in the message history
      const stream = await streamCompletion({
        messages: this.getMessages(),
        provider: this.provider,
        model: this.model,
        maxTokens: 4000,
        temperature: 0.7
      });

      // Collect and display the response
      let fullResponse = '';

      await writeStreamingResponse({
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of stream.textStream) {
            fullResponse += chunk;
            yield chunk;
          }
        }
      });

      // Add assistant response to history
      this.addMessage('assistant', fullResponse);

      return fullResponse;
    } catch (error) {
      // Remove the user message if we failed
      this.messages.pop();
      throw error;
    }
  }
}

/**
 * Run an interactive chat session
 * @param {string} systemPrompt - Initial system prompt with Today context
 * @param {object} options - Session options
 * @param {string} options.provider - AI provider name
 * @param {string} options.model - Model name
 * @param {function} options.refreshContextFn - Function to refresh context
 */
export async function runChatSession(systemPrompt, options = {}) {
  // Check if we need to use compact mode based on provider's context limit
  let promptToUse = systemPrompt;
  let usingCompactMode = false;
  let refFilePath = null;

  const provider = options.provider || 'ollama';
  const model = options.model || 'llama3.2';

  // Get the effective context limit for this provider/model
  const { contextLimit, source } = await getEffectiveContextLimit(provider, model);
  const tokenLimit = contextLimit - RESPONSE_TOKEN_RESERVE;

  const originalTokens = estimateTokens(systemPrompt);
  if (originalTokens > tokenLimit) {
    // Write query instructions to a reference file
    refFilePath = writeReferenceFile(systemPrompt);

    // Compactify the prompt
    promptToUse = compactifyPrompt(systemPrompt, refFilePath);
    const compactTokens = estimateTokens(promptToUse);
    usingCompactMode = true;

    console.log();
    displayInfo(`Context too large for ${provider} (~${originalTokens} tokens, limit: ${tokenLimit} from ${source})`);
    displayInfo(`Using compact mode (~${compactTokens} tokens)`);
    if (refFilePath) {
      displayInfo(`Query reference saved to: ${refFilePath}`);
    }
  }

  const session = new ChatSession(promptToUse, options);
  const rl = createChatInterface();

  // Display the prompt (compact or full)
  console.log();
  console.log(promptToUse);
  console.log();
  displayHeader(session.provider, session.model);
  if (usingCompactMode) {
    displayInfo('Tip: Use a cloud provider (anthropic, openai) for full context support');
    console.log();
  }

  // Handle clean exit on Ctrl+C
  rl.on('close', () => {
    console.log('\n');
    displayInfo('Session ended.');
    process.exit(0);
  });

  // Get initial response from assistant (like Claude does)
  // Pass the prompt as a user message so the model responds to it
  try {
    const initialStream = await streamCompletion({
      messages: [{ role: 'user', content: promptToUse }],
      provider: session.provider,
      model: session.model,
      maxTokens: 4000,
      temperature: 0.7
    });

    let initialResponse = '';
    await writeStreamingResponse({
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of initialStream.textStream) {
          initialResponse += chunk;
          yield chunk;
        }
      }
    });

    // Add to history so follow-ups have context
    session.addMessage('user', promptToUse);
    session.addMessage('assistant', initialResponse);
  } catch (error) {
    displayError(`Failed to get initial response: ${error.message}`);
  }

  // Main REPL loop
  while (true) {
    try {
      const input = await prompt(rl);

      // Skip empty input
      if (!input || !input.trim()) {
        continue;
      }

      // Check for slash commands
      if (input.startsWith('/')) {
        const result = session.processSlashCommand(input);
        if (result.handled) {
          if (result.action === 'quit') {
            break;
          }
          if (result.action === 'refresh_context' && options.refreshContextFn) {
            try {
              displayInfo('Refreshing context...');
              session.systemPrompt = await options.refreshContextFn();
              displayInfo('Context refreshed.');
            } catch (error) {
              displayError(`Failed to refresh context: ${error.message}`);
            }
          }
          continue;
        }
      }

      // Send message to AI
      await session.chat(input);
    } catch (error) {
      if (error.code === 'ERR_USE_AFTER_CLOSE') {
        // Readline was closed (Ctrl+C)
        break;
      }
      displayError(error.message);
    }
  }

  rl.close();
  console.log();
  displayInfo('Session ended.');
}

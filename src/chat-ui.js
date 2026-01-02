/**
 * Chat UI - Readline-based interface for interactive chat sessions
 */

import * as readline from 'readline';
import { colors } from './cli-utils.js';

/**
 * Create a readline interface for chat input
 * @returns {readline.Interface}
 */
export function createChatInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
}

/**
 * Prompt user for input
 * @param {readline.Interface} rl - Readline interface
 * @param {string} promptText - Text to display before input
 * @returns {Promise<string>} - User's input
 */
export function prompt(rl, promptText = 'You: ') {
  return new Promise((resolve) => {
    rl.question(colors.cyan(promptText), (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Write streaming text to stdout with thinking indicator
 * @param {AsyncIterable<string>} textStream - Stream from AI provider
 */
export async function writeStreamingResponse(textStream) {
  // Show thinking indicator with elapsed time
  const startTime = Date.now();
  let thinkingInterval;
  let currentThinkingText = '';

  const updateThinking = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const newText = colors.gray(`Thinking... (${elapsed}s)`);
    // Clear previous and write new
    process.stdout.write('\r' + ' '.repeat(currentThinkingText.length) + '\r');
    process.stdout.write(newText);
    currentThinkingText = newText;
  };

  // Initial display
  updateThinking();
  // Update every second
  thinkingInterval = setInterval(updateThinking, 1000);

  let firstChunk = true;
  try {
    for await (const chunk of textStream) {
      if (firstChunk) {
        // Stop the timer and clear thinking indicator
        clearInterval(thinkingInterval);
        process.stdout.write('\r' + ' '.repeat(currentThinkingText.length) + '\r');
        process.stdout.write(colors.green('Assistant: '));
        firstChunk = false;
      }
      process.stdout.write(chunk);
    }
  } finally {
    clearInterval(thinkingInterval);
  }

  // Handle case where no tokens were received
  if (firstChunk) {
    process.stdout.write('\r' + ' '.repeat(currentThinkingText.length) + '\r');
    process.stdout.write(colors.green('Assistant: ') + colors.gray('(no response)'));
  }

  // End with newlines for clean formatting
  process.stdout.write('\n\n');
}

/**
 * Display a complete message (for history replay)
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - Message content
 */
export function displayMessage(role, content) {
  if (role === 'user') {
    console.log(colors.cyan('You: ') + content);
  } else {
    console.log(colors.green('Assistant: ') + content);
  }
  console.log();
}

/**
 * Display chat header with provider info
 * @param {string} provider - AI provider name
 * @param {string} model - Model name
 */
export function displayHeader(provider, model) {
  console.log();
  console.log(colors.bold(`Today Chat - Using ${provider}/${model}`));
  console.log(colors.gray('Type /help for commands, /quit to exit'));
  console.log();
}

/**
 * Display help message
 */
export function displayHelp() {
  console.log();
  console.log(colors.bold('Available commands:'));
  console.log('  /quit, /exit  - End the session');
  console.log('  /clear        - Clear conversation history');
  console.log('  /context      - Refresh Today context');
  console.log('  /history      - Show conversation history');
  console.log('  /model        - Show current provider and model');
  console.log('  /help         - Show this help message');
  console.log();
}

/**
 * Display error message
 * @param {string} message - Error message
 */
export function displayError(message) {
  console.log(colors.red(`Error: ${message}`));
  console.log();
}

/**
 * Display info message
 * @param {string} message - Info message
 */
export function displayInfo(message) {
  console.log(colors.gray(message));
}

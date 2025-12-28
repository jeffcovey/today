/**
 * AI Provider Abstraction Layer using Vercel AI SDK
 *
 * Provides a common interface for different AI providers (Anthropic, OpenAI, Ollama, Google)
 * using the Vercel AI SDK for unified API access and streaming support.
 *
 * Usage:
 *   import { createCompletion, streamCompletion } from './ai-provider.js';
 *
 *   // Simple completion
 *   const response = await createCompletion({
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *     maxTokens: 1000,
 *   });
 *
 *   // Streaming completion
 *   const stream = await streamCompletion({
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *   });
 *   for await (const chunk of stream.textStream) {
 *     process.stdout.write(chunk);
 *   }
 */

import { generateText, streamText } from 'ai';
import { getFullConfig } from './config.js';

// Provider imports - these are loaded dynamically to avoid issues if not configured
let anthropicProvider = null;
let openaiProvider = null;
let googleProvider = null;
let ollamaProvider = null;

/**
 * Get the Anthropic provider/model
 */
async function getAnthropicModel(modelName) {
  if (!anthropicProvider) {
    const { anthropic } = await import('@ai-sdk/anthropic');
    anthropicProvider = anthropic;
  }
  return anthropicProvider(modelName);
}

/**
 * Get the OpenAI provider/model
 */
async function getOpenAIModel(modelName, options = {}) {
  if (!openaiProvider) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    openaiProvider = createOpenAI({
      baseURL: options.baseURL || process.env.OPENAI_BASE_URL,
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
    });
  }
  return openaiProvider(modelName);
}

/**
 * Get the Google provider/model
 */
async function getGoogleModel(modelName) {
  if (!googleProvider) {
    const { google } = await import('@ai-sdk/google');
    googleProvider = google;
  }
  return googleProvider(modelName);
}

/**
 * Get the Ollama provider/model
 */
async function getOllamaModel(modelName, options = {}) {
  if (!ollamaProvider) {
    const { createOllama } = await import('ollama-ai-provider-v2');
    ollamaProvider = createOllama({
      baseURL: options.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/api',
    });
  }
  return ollamaProvider(modelName);
}

// Default models for each provider
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-1.5-flash',
  ollama: 'llama3.2',
};

/**
 * Get the configured model for the current provider
 * @returns {Promise<object>} - The AI SDK model object
 */
async function getConfiguredModel() {
  const config = getFullConfig();
  const aiConfig = config.ai || {};

  const providerName = aiConfig.provider || 'anthropic';
  const modelName = aiConfig.model || DEFAULT_MODELS[providerName];

  switch (providerName) {
    case 'anthropic':
      return getAnthropicModel(modelName);
    case 'openai':
      return getOpenAIModel(modelName, {
        baseURL: aiConfig.openai?.base_url || aiConfig.openai?.baseURL,
        apiKey: aiConfig.openai?.api_key || aiConfig.openai?.apiKey,
      });
    case 'google':
    case 'gemini':
      return getGoogleModel(modelName);
    case 'ollama':
      return getOllamaModel(modelName, {
        baseURL: aiConfig.ollama?.base_url || aiConfig.ollama?.baseURL,
      });
    default:
      throw new Error(`Unknown AI provider: ${providerName}. Available: anthropic, openai, google, ollama`);
  }
}

/**
 * Create a completion (non-streaming)
 * @param {Object} options
 * @param {Array} options.messages - Array of {role, content} messages
 * @param {string} [options.system] - System prompt
 * @param {number} [options.maxTokens=1000] - Maximum tokens to generate
 * @param {number} [options.temperature=0] - Temperature (0-1)
 * @returns {Promise<string>} - The generated text
 */
export async function createCompletion(options) {
  const model = await getConfiguredModel();

  const result = await generateText({
    model,
    system: options.system,
    messages: options.messages || [],
    maxTokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0,
  });

  return result.text;
}

/**
 * Create a streaming completion
 * @param {Object} options - Same as createCompletion
 * @returns {Promise<object>} - Stream result with textStream property
 */
export async function streamCompletion(options) {
  const model = await getConfiguredModel();

  return streamText({
    model,
    system: options.system,
    messages: options.messages || [],
    maxTokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0,
  });
}

/**
 * Check if the configured AI provider is available
 * @returns {Promise<boolean>}
 */
export async function isAIAvailable() {
  const config = getFullConfig();
  const aiConfig = config.ai || {};
  const providerName = aiConfig.provider || 'anthropic';

  try {
    switch (providerName) {
      case 'anthropic':
        return !!(process.env.ANTHROPIC_API_KEY || process.env.TODAY_ANTHROPIC_KEY);
      case 'openai':
        return !!(process.env.OPENAI_API_KEY || aiConfig.openai?.api_key);
      case 'google':
      case 'gemini':
        return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || aiConfig.google?.api_key);
      case 'ollama':
        // Check if Ollama is reachable
        const baseURL = aiConfig.ollama?.base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        const response = await fetch(`${baseURL}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });
        return response.ok;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get the name of the configured background provider
 * @returns {string}
 */
export function getProviderName() {
  const config = getFullConfig();
  return config.ai?.provider || 'anthropic';
}

/**
 * Get the name of the configured interactive provider
 * @returns {string}
 */
export function getInteractiveProviderName() {
  const config = getFullConfig();
  return config.ai?.interactive_provider || 'anthropic';
}

/**
 * Get the configured interactive model
 * @returns {string}
 */
export function getInteractiveModel() {
  const config = getFullConfig();
  return config.ai?.interactive_model || 'sonnet';
}

/**
 * Get the configured model name for the current provider
 * @returns {string}
 */
export function getConfiguredModelName() {
  const config = getFullConfig();
  const aiConfig = config.ai || {};
  const providerName = aiConfig.provider || 'anthropic';
  return aiConfig.model || DEFAULT_MODELS[providerName];
}

/**
 * Clear cached providers (useful for testing or config changes)
 */
export function clearProviderCache() {
  anthropicProvider = null;
  openaiProvider = null;
  googleProvider = null;
  ollamaProvider = null;
}

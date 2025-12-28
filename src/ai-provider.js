/**
 * AI Provider Abstraction Layer
 *
 * Provides a common interface for different AI providers (Anthropic, OpenAI, Ollama, etc.)
 * allowing users to choose their preferred AI backend.
 *
 * Usage:
 *   import { getAIProvider, createCompletion } from './ai-provider.js';
 *
 *   // Get configured provider
 *   const provider = getAIProvider();
 *
 *   // Create a completion
 *   const response = await createCompletion({
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *     maxTokens: 1000,
 *   });
 */

import { getConfig, getFullConfig } from './config.js';

/**
 * Base class for AI providers
 */
class AIProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Create a chat completion
   * @param {Object} options
   * @param {Array} options.messages - Array of {role, content} messages
   * @param {string} [options.system] - System prompt
   * @param {number} [options.maxTokens=1000] - Maximum tokens to generate
   * @param {number} [options.temperature=0] - Temperature (0-1)
   * @param {string} [options.model] - Override the configured model
   * @returns {Promise<string>} - The generated text
   */
  async complete(options) {
    throw new Error('complete() must be implemented by provider');
  }

  /**
   * Get the provider name
   */
  get name() {
    throw new Error('name getter must be implemented by provider');
  }

  /**
   * Check if the provider is available (has required credentials/connectivity)
   */
  async isAvailable() {
    return false;
  }
}

/**
 * Anthropic Claude provider
 */
class AnthropicProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    // Support both camelCase and snake_case config keys
    this.apiKey = config.apiKey || config.api_key || process.env.TODAY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
    this.defaultModel = config.model || 'claude-sonnet-4-20250514';
  }

  get name() {
    return 'anthropic';
  }

  async isAvailable() {
    return !!this.apiKey;
  }

  async complete(options) {
    if (!this.apiKey) {
      throw new Error('Anthropic API key not configured. Set TODAY_ANTHROPIC_KEY or ANTHROPIC_API_KEY environment variable.');
    }

    // Dynamic import to avoid loading SDK if not needed
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });

    const messages = options.messages || [];
    const systemPrompt = options.system || '';

    const response = await client.messages.create({
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0,
      system: systemPrompt,
      messages: messages,
    });

    return response.content[0].text;
  }
}

/**
 * OpenAI provider (GPT-4, etc.)
 */
class OpenAIProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    // Support both camelCase and snake_case config keys
    this.apiKey = config.apiKey || config.api_key || process.env.OPENAI_API_KEY;
    this.defaultModel = config.model || 'gpt-4o';
    this.baseURL = config.baseURL || config.base_url || process.env.OPENAI_BASE_URL;
  }

  get name() {
    return 'openai';
  }

  async isAvailable() {
    return !!this.apiKey;
  }

  async complete(options) {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable.');
    }

    // Dynamic import to avoid loading SDK if not needed
    const { default: OpenAI } = await import('openai');
    const clientOptions = { apiKey: this.apiKey };
    if (this.baseURL) {
      clientOptions.baseURL = this.baseURL;
    }
    const client = new OpenAI(clientOptions);

    const messages = [];

    // Add system message if provided
    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }

    // Add user messages
    if (options.messages) {
      messages.push(...options.messages);
    }

    const response = await client.chat.completions.create({
      model: options.model || this.defaultModel,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0,
      messages: messages,
    });

    return response.choices[0].message.content;
  }
}

/**
 * Ollama provider (local models)
 */
class OllamaProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    // Support both camelCase and snake_case config keys
    this.baseURL = config.baseURL || config.base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.defaultModel = config.model || 'llama3.2';
  }

  get name() {
    return 'ollama';
  }

  async isAvailable() {
    try {
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(options) {
    const messages = [];

    // Add system message if provided
    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }

    // Add user messages
    if (options.messages) {
      messages.push(...options.messages);
    }

    const response = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || this.defaultModel,
        messages: messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0,
          num_predict: options.maxTokens || 1000,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama request failed: ${error}`);
    }

    const result = await response.json();
    return result.message?.content || '';
  }
}

/**
 * Google Gemini provider
 */
class GeminiProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    // Support both camelCase and snake_case config keys
    this.apiKey = config.apiKey || config.api_key || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    this.defaultModel = config.model || 'gemini-1.5-flash';
  }

  get name() {
    return 'gemini';
  }

  async isAvailable() {
    return !!this.apiKey;
  }

  async complete(options) {
    if (!this.apiKey) {
      throw new Error('Google API key not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.');
    }

    // Dynamic import
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.apiKey);

    const model = genAI.getGenerativeModel({
      model: options.model || this.defaultModel,
    });

    // Build the prompt from messages
    let prompt = '';
    if (options.system) {
      prompt += options.system + '\n\n';
    }
    for (const msg of (options.messages || [])) {
      if (msg.role === 'user') {
        prompt += msg.content;
      }
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 1000,
        temperature: options.temperature ?? 0,
      },
    });

    return result.response.text();
  }
}

// Provider registry
const providers = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  ollama: OllamaProvider,
  gemini: GeminiProvider,
};

// Cached provider instance
let cachedProvider = null;
let cachedProviderName = null;

/**
 * Get the configured AI provider
 * @param {string} [providerName] - Override the configured provider
 * @returns {AIProvider}
 */
export function getAIProvider(providerName = null) {
  const config = getFullConfig();
  const aiConfig = config.ai || {};

  const name = providerName || aiConfig.provider || 'anthropic';

  // Return cached provider if same name
  if (cachedProvider && cachedProviderName === name) {
    return cachedProvider;
  }

  const ProviderClass = providers[name];
  if (!ProviderClass) {
    throw new Error(`Unknown AI provider: ${name}. Available: ${Object.keys(providers).join(', ')}`);
  }

  // Get provider-specific config
  const providerConfig = {
    model: aiConfig.model || aiConfig.claude_model || aiConfig.api_model, // support legacy keys
    ...aiConfig[name], // e.g., ai.ollama.base_url
  };

  cachedProvider = new ProviderClass(providerConfig);
  cachedProviderName = name;

  return cachedProvider;
}

/**
 * Clear the cached provider (useful for testing or config changes)
 */
export function clearProviderCache() {
  cachedProvider = null;
  cachedProviderName = null;
}

/**
 * Convenience function to create a completion with the configured provider
 * @param {Object} options - Same options as AIProvider.complete()
 * @returns {Promise<string>}
 */
export async function createCompletion(options) {
  const provider = getAIProvider();
  return provider.complete(options);
}

/**
 * Check if any AI provider is available
 * @returns {Promise<boolean>}
 */
export async function isAIAvailable() {
  try {
    const provider = getAIProvider();
    return await provider.isAvailable();
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
 * Get the configured model for the current provider
 * @returns {string}
 */
export function getConfiguredModel() {
  const config = getFullConfig();
  const aiConfig = config.ai || {};
  return aiConfig.model || aiConfig.claude_model || aiConfig.api_model || getAIProvider().defaultModel;
}

// Export provider classes for direct use if needed
export { AIProvider, AnthropicProvider, OpenAIProvider, OllamaProvider, GeminiProvider };

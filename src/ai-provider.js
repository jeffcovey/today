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

// Suppress AI SDK compatibility warnings (e.g., ollama v2 specification mode)
globalThis.AI_SDK_LOG_WARNINGS = false;

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
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    // Support both ANTHROPIC_API_KEY and TODAY_ANTHROPIC_KEY
    anthropicProvider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.TODAY_ANTHROPIC_KEY,
    });
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
  'anthropic-api': 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-1.5-flash',
  ollama: 'llama3.2',
};

// Default maximum context window for Ollama (higher values may cause timeouts on limited hardware)
const OLLAMA_DEFAULT_MAX_CONTEXT = 8192;

// Cache for Ollama model info
let ollamaModelInfoCache = new Map();

/**
 * Get Ollama model information including context length
 * @param {string} modelName - The model name
 * @param {string} baseURL - Ollama base URL
 * @returns {Promise<{contextLength: number, parameterSize: string}|null>}
 */
async function getOllamaModelInfo(modelName, baseURL = 'http://localhost:11434') {
  const cacheKey = `${baseURL}:${modelName}`;
  if (ollamaModelInfoCache.has(cacheKey)) {
    return ollamaModelInfoCache.get(cacheKey);
  }

  try {
    const response = await fetch(`${baseURL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const info = {
      contextLength: data.model_info?.['llama.context_length'] ||
                     data.model_info?.['context_length'] ||
                     null,
      parameterSize: data.details?.parameter_size || null,
    };

    ollamaModelInfoCache.set(cacheKey, info);
    return info;
  } catch {
    return null;
  }
}

/**
 * Get effective context limit for Ollama
 * Uses model's context length but caps at hardware limit from config
 * @param {string} modelName - The model name
 * @param {object} aiConfig - AI config from config.toml
 * @returns {Promise<number>}
 */
async function getOllamaContextLimit(modelName, aiConfig = {}) {
  // User can override the max context in config
  const configMax = aiConfig.ollama?.max_context || OLLAMA_DEFAULT_MAX_CONTEXT;

  // Try to get model's actual context length
  const baseURL = aiConfig.ollama?.base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const modelInfo = await getOllamaModelInfo(modelName, baseURL);

  if (modelInfo?.contextLength) {
    // Use the smaller of model's context and configured max
    return Math.min(modelInfo.contextLength, configMax);
  }

  return configMax;
}

// Model name patterns for each provider (to detect mismatched configs)
const PROVIDER_MODEL_PATTERNS = {
  anthropic: /^(claude|sonnet|opus|haiku)/i,
  'anthropic-api': /^(claude|sonnet|opus|haiku)/i,
  openai: /^(gpt|o1|o3|davinci|curie|babbage|ada)/i,
  google: /^(gemini|palm|bard)/i,
  ollama: /^(llama|mistral|codellama|phi|qwen|deepseek|gemma|vicuna|neural|wizard|orca|stable|dolphin|openchat|zephyr|solar|yi|command)/i,
};

/**
 * Check if a model name matches a provider
 */
function modelMatchesProvider(modelName, providerName) {
  const pattern = PROVIDER_MODEL_PATTERNS[providerName];
  if (!pattern) return true; // Unknown provider, assume it matches
  return pattern.test(modelName);
}

/**
 * Get the configured model for a given provider
 * @param {object} options - Options to override config
 * @param {string} [options.provider] - Provider name (overrides config)
 * @param {string} [options.model] - Model name (overrides config)
 * @returns {Promise<object>} - The AI SDK model object
 */
async function getConfiguredModel(options = {}) {
  const config = getFullConfig();
  const aiConfig = config.ai || {};

  const providerName = options.provider || aiConfig.provider || 'anthropic';
  let modelName = options.model || aiConfig.model || DEFAULT_MODELS[providerName];

  // If the model doesn't match the provider (e.g., "opus" with ollama), use the default
  if (modelName && !modelMatchesProvider(modelName, providerName)) {
    modelName = DEFAULT_MODELS[providerName];
  }

  switch (providerName) {
    case 'anthropic':
    case 'anthropic-api':
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
      throw new Error(`Unknown AI provider: ${providerName}. Available: anthropic, anthropic-api, openai, google, ollama`);
  }
}

/**
 * Create a completion (non-streaming)
 * @param {Object} options
 * @param {Array} options.messages - Array of {role, content} messages
 * @param {string} [options.system] - System prompt
 * @param {string} [options.provider] - AI provider (overrides config)
 * @param {string} [options.model] - Model name (overrides config)
 * @param {number} [options.maxTokens=1000] - Maximum tokens to generate
 * @param {number} [options.temperature=0] - Temperature (0-1)
 * @param {Object} [options.tools] - Tool definitions for the AI to use
 * @param {number} [options.maxSteps=5] - Maximum tool use iterations
 * @returns {Promise<string>} - The generated text
 */
export async function createCompletion(options) {
  const config = getFullConfig();
  const providerName = options.provider || config.ai?.provider || 'anthropic';

  const model = await getConfiguredModel({
    provider: options.provider,
    model: options.model,
  });

  const genOptions = {
    model,
    system: options.system,
    messages: options.messages || [],
    maxTokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0,
  };

  // Add tools if provided
  if (options.tools) {
    genOptions.tools = options.tools;
    genOptions.maxSteps = options.maxSteps || 5;
    console.log('[AI Provider] createCompletion with tools:', Object.keys(options.tools), 'maxSteps:', genOptions.maxSteps);
  }

  // For Ollama, dynamically set context window based on prompt size (with cap)
  if (providerName === 'ollama') {
    const charCount = getMessagesCharCount(options.messages, options.system);
    const estimatedTokens = estimateTokens(charCount);
    const calculatedCtx = estimatedTokens + (options.maxTokens || 1000) + 1000;
    // Cap at OLLAMA_DEFAULT_MAX_CONTEXT to avoid timeouts on limited hardware
    const numCtx = Math.min(OLLAMA_DEFAULT_MAX_CONTEXT, Math.max(4096, Number.isFinite(calculatedCtx) ? calculatedCtx : 4096));

    genOptions.providerOptions = {
      ollama: {
        options: {
          num_ctx: Math.round(numCtx),
        },
      },
    };
  }

  const result = await generateText(genOptions);

  // Minimal logging for tool usage (verbose logs disabled to avoid polluting command output)
  if (options.tools && result.steps) {
    const toolCallCount = result.steps.reduce((sum, s) => sum + (s.toolCalls?.length || 0), 0);
    if (toolCallCount > 0) {
      console.error(`[AI] ${toolCallCount} tool call(s), ${result.steps.length} step(s)`);
    }
  }

  // Build response: model's text + tool results summary
  let responseText = result.text || '';

  if (options.tools && result.steps) {
    const toolResults = [];
    for (const step of result.steps) {
      if (step.toolResults) {
        for (const tr of step.toolResults) {
          toolResults.push(tr);
        }
      }
    }

    // Build tool results summary
    if (toolResults.length > 0) {
      const summaryParts = [];
      for (const tr of toolResults) {
        const toolName = tr.toolName || 'unknown';
        const output = tr.output;

        if (toolName === 'run_command') {
          if (output?.success) {
            const cleanOutput = (output.output || '').trim();
            if (cleanOutput) {
              summaryParts.push(`✓ ${cleanOutput}`);
            }
          } else {
            const errorMsg = output?.stderr || output?.error || 'Command failed';
            // Include what was attempted for context
            const attempted = tr.input?.args ? `\`${tr.input.command} ${tr.input.args}\`` : tr.input?.command;
            summaryParts.push(`✗ Failed: ${attempted}\n   ${errorMsg.trim()}`);
          }
        } else if (toolName === 'query_database') {
          if (output?.success) {
            summaryParts.push(`✓ Query returned ${output.rowCount} results`);
          } else {
            summaryParts.push(`✗ Query error: ${output?.error || 'Unknown error'}`);
          }
        } else if (toolName === 'edit_file') {
          if (output?.success) {
            summaryParts.push(`✓ ${output.message || 'File updated'}`);
          } else {
            summaryParts.push(`✗ Edit failed: ${output?.error || 'Unknown error'}`);
          }
        }
      }

      // Combine model text with tool results
      if (summaryParts.length > 0) {
        // Use double newlines for markdown paragraph breaks
        const toolSummary = summaryParts.join('\n\n');
        // If model text is just fluff like "I'll add...", replace it
        const fluffPatterns = /^(I('ll| will)|Let me|Sure|OK|Okay)/i;
        if (!responseText || responseText.length < 100 || fluffPatterns.test(responseText.trim())) {
          responseText = toolSummary;
        } else {
          // Model had substantive text, append tool results
          responseText = responseText.trim() + '\n\n**Results:**\n\n' + toolSummary;
        }
      }
    }
  }

  return responseText;
}

/**
 * Estimate token count from character count (rough approximation: ~4 chars per token)
 */
function estimateTokens(charCount) {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0;
  return Math.ceil(charCount / 4);
}

/**
 * Calculate total character count for messages
 */
function getMessagesCharCount(messages, system) {
  let total = 0;
  if (system && typeof system === 'string') {
    total += system.length;
  }
  for (const msg of messages || []) {
    if (msg.content && typeof msg.content === 'string') {
      total += msg.content.length;
    }
  }
  return total;
}

/**
 * Create a streaming completion
 * @param {Object} options - Same as createCompletion
 * @param {Object} [options.tools] - Tool definitions for the AI to use
 * @param {number} [options.maxSteps=5] - Maximum tool use iterations
 * @param {Function} [options.onStepFinish] - Callback when a step (text or tool) finishes
 * @returns {Promise<object>} - Stream result with textStream and fullStream properties
 */
export async function streamCompletion(options) {
  const config = getFullConfig();
  const providerName = options.provider || config.ai?.provider || 'anthropic';

  const model = await getConfiguredModel({
    provider: options.provider,
    model: options.model,
  });

  const streamOptions = {
    model,
    system: options.system,
    messages: options.messages || [],
    maxTokens: options.maxTokens || 1000,
    temperature: options.temperature ?? 0,
  };

  // Add tools if provided
  if (options.tools) {
    streamOptions.tools = options.tools;
    streamOptions.maxSteps = options.maxSteps || 5;
    console.log('[AI Provider] Tools enabled, maxSteps:', streamOptions.maxSteps, 'tool count:', Object.keys(options.tools).length);
  }

  // Add step finish callback if provided
  if (options.onStepFinish) {
    streamOptions.onStepFinish = options.onStepFinish;
  }

  // For Ollama, dynamically set context window based on prompt size (with cap)
  if (providerName === 'ollama') {
    const charCount = getMessagesCharCount(options.messages, options.system);
    const estimatedTokens = estimateTokens(charCount);
    // Context needs: input tokens + output tokens + buffer
    const calculatedCtx = estimatedTokens + (options.maxTokens || 4000) + 1000;
    // Cap at OLLAMA_DEFAULT_MAX_CONTEXT to avoid timeouts on limited hardware
    const numCtx = Math.min(OLLAMA_DEFAULT_MAX_CONTEXT, Math.max(4096, Number.isFinite(calculatedCtx) ? calculatedCtx : 4096));

    streamOptions.providerOptions = {
      ollama: {
        options: {
          num_ctx: Math.round(numCtx),
        },
      },
    };
  }

  return streamText(streamOptions);
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
      case 'anthropic-api':
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
  const interactiveProvider = config.ai?.interactive_provider || 'anthropic';
  // Map anthropic-api to anthropic for DEFAULT_MODELS lookup
  const providerKey = interactiveProvider === 'anthropic-api' ? 'anthropic' : interactiveProvider;
  return config.ai?.interactive_model || DEFAULT_MODELS[providerKey] || DEFAULT_MODELS.anthropic;
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
  ollamaModelInfoCache.clear();
}

/**
 * Get Ollama model info (exported for use by chat-session)
 * @param {string} modelName - The model name
 * @returns {Promise<{contextLength: number, parameterSize: string}|null>}
 */
export { getOllamaModelInfo };

/**
 * Get the effective token limit for compact mode decisions
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @returns {Promise<{contextLimit: number, source: string}>}
 */
export async function getEffectiveContextLimit(provider, model) {
  if (provider !== 'ollama') {
    // Cloud providers have large context windows, no need for compact mode
    return { contextLimit: 200000, source: 'cloud-provider' };
  }

  const config = getFullConfig();
  const aiConfig = config.ai || {};

  // Check for user-configured max
  const configMax = aiConfig.ollama?.max_context;
  if (configMax) {
    return { contextLimit: configMax, source: 'config' };
  }

  // Try to get model info from Ollama
  const baseURL = aiConfig.ollama?.base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const modelInfo = await getOllamaModelInfo(model, baseURL);

  if (modelInfo?.contextLength) {
    // Model advertises context, but cap at default for hardware safety
    const effectiveLimit = Math.min(modelInfo.contextLength, OLLAMA_DEFAULT_MAX_CONTEXT);
    return {
      contextLimit: effectiveLimit,
      source: `model (${modelInfo.parameterSize || 'unknown size'}, capped at ${OLLAMA_DEFAULT_MAX_CONTEXT})`,
    };
  }

  return { contextLimit: OLLAMA_DEFAULT_MAX_CONTEXT, source: 'default' };
}

/**
 * Provider requirements for interactive sessions
 */
const INTERACTIVE_PROVIDER_REQUIREMENTS = {
  anthropic: {
    binary: 'claude',
    name: 'Claude Code CLI',
    installInstructions: [
      'npm install -g @anthropic-ai/claude-code',
      '',
      'Then authenticate by running:',
      '   claude',
    ],
  },
  ollama: {
    binary: 'ollama',
    name: 'Ollama',
    installInstructions: [
      'Install from: https://ollama.ai/download',
      '',
      'Then start the server:',
      '   ollama serve',
    ],
  },
  // API-only providers don't need binaries for interactive use
  'anthropic-api': null, // Uses API key directly with built-in chat
  openai: null,
  google: null,
  gemini: null,
};

/**
 * Get the interactive provider requirements
 * @returns {Object} - The requirements mapping
 */
export function getInteractiveProviderRequirements() {
  return INTERACTIVE_PROVIDER_REQUIREMENTS;
}

/**
 * Check if a provider's binary requirements are met (sync version for CLI use)
 * @param {string} providerName - The provider to check
 * @param {function} spawnSync - The spawnSync function to use
 * @returns {{ available: boolean, requirement?: object }}
 */
export function checkProviderBinarySync(providerName, spawnSync) {
  const requirement = INTERACTIVE_PROVIDER_REQUIREMENTS[providerName];

  if (!requirement) {
    // No binary required
    return { available: true };
  }

  const which = spawnSync('which', [requirement.binary], { encoding: 'utf8' });
  const available = which.status === 0;

  return { available, requirement };
}

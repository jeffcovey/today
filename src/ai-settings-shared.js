/**
 * Shared AI settings configuration
 *
 * Used by both configure-ui.js (local settings) and
 * deployments-configure-ui.js (per-deployment overrides)
 */

import { execSync } from 'child_process';

// AI provider to env var mapping
export const AI_PROVIDER_ENV_VARS = {
  anthropic: { key: 'TODAY_ANTHROPIC_KEY', label: 'Anthropic API Key' },
  'anthropic-api': { key: 'TODAY_ANTHROPIC_KEY', label: 'Anthropic API Key' },
  openai: { key: 'OPENAI_API_KEY', label: 'OpenAI API Key' },
  gemini: { key: 'GOOGLE_API_KEY', label: 'Google API Key' },
  ollama: null, // Local, no key needed
};

// Background provider options (no Claude CLI option - background tasks use API)
export const BACKGROUND_PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai', label: 'OpenAI (GPT-4, etc.)' },
  { value: 'ollama', label: 'Ollama (Local models)' },
  { value: 'gemini', label: 'Google Gemini' },
];

// Interactive provider options (includes Claude CLI option)
export const INTERACTIVE_PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic Claude (uses Claude CLI)' },
  { value: 'anthropic-api', label: 'Anthropic Claude (uses API key)' },
  { value: 'ollama', label: 'Ollama (Local models)' },
  { value: 'openai', label: 'OpenAI (GPT-4, etc.)' },
  { value: 'gemini', label: 'Google Gemini' },
];

/**
 * Get available Ollama models by running `ollama list`
 * @returns {Array<{value: string, label: string}>} - Array of model options
 */
export function getOllamaModels() {
  try {
    const output = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n').slice(1); // Skip header row
    const models = lines
      .map(line => {
        const name = line.split(/\s+/)[0]; // First column is model name
        return name ? { value: name, label: name } : null;
      })
      .filter(Boolean);
    return models.length > 0 ? models : [{ value: 'llama3.2', label: 'llama3.2 (default)' }];
  } catch {
    // Ollama not installed or not running
    return [{ value: 'llama3.2', label: 'llama3.2 (default - ollama not found)' }];
  }
}

/**
 * Get model options based on provider
 * @param {string} provider - The AI provider name
 * @returns {Array<{value: string, label: string}>|null} - Options array or null for free-form input
 */
export function getModelOptionsForProvider(provider) {
  switch (provider) {
    case 'ollama':
      return getOllamaModels();
    case 'anthropic':
    case 'anthropic-api':
      return [
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Recommended)' },
        { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Fast)' },
      ];
    case 'openai':
      return [
        { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
        { value: 'o1', label: 'o1 (Reasoning)' },
        { value: 'o3-mini', label: 'o3-mini (Reasoning, Fast)' },
      ];
    case 'gemini':
    case 'google':
      return [
        { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (Recommended)' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      ];
    default:
      return null; // Free-form input for unknown providers
  }
}

/**
 * AI Settings field definitions
 * Used by both local settings and deployment settings
 *
 * @param {Object} options
 * @param {boolean} options.isDeployment - If true, adds "(use default)" options
 * @param {Function} options.getProvider - Function to get current background provider from config
 * @param {Function} options.getInteractiveProvider - Function to get current interactive provider from config
 * @returns {Array} Field definitions for AI settings
 */
export function getAiSettingsFields({ isDeployment = false, getProvider, getInteractiveProvider }) {
  const defaultOption = isDeployment ? [{ value: '', label: '(use default)' }] : [];

  return [
    {
      key: 'provider',
      label: 'Background Provider',
      configKey: 'provider',
      default: isDeployment ? '' : 'anthropic',
      type: 'select',
      options: [...defaultOption, ...BACKGROUND_PROVIDER_OPTIONS],
      description: 'AI for background tasks (summaries, tagging)'
    },
    {
      key: 'model',
      label: 'Background Model',
      configKey: 'model',
      default: '',
      type: 'dynamic-select',
      getOptions: () => {
        const provider = getProvider();
        if (!provider && isDeployment) return [{ value: '', label: '(use default)' }];
        const models = getModelOptionsForProvider(provider || 'anthropic') || [];
        return isDeployment ? [{ value: '', label: '(use default)' }, ...models] : models;
      },
      description: 'Model for background tasks'
    },
    {
      key: 'interactive_provider',
      label: 'Interactive Provider',
      configKey: 'interactive_provider',
      default: isDeployment ? '' : 'anthropic',
      type: 'select',
      options: [...defaultOption, ...INTERACTIVE_PROVIDER_OPTIONS],
      description: 'AI for interactive sessions (bin/today)'
    },
    {
      key: 'interactive_model',
      label: 'Interactive Model',
      configKey: 'interactive_model',
      default: '',
      type: 'dynamic-select',
      getOptions: () => {
        const provider = getInteractiveProvider();
        if (!provider && isDeployment) return [{ value: '', label: '(use default)' }];
        const models = getModelOptionsForProvider(provider || 'anthropic') || [];
        return isDeployment ? [{ value: '', label: '(use default)' }, ...models] : models;
      },
      description: 'Model for interactive sessions'
    },
    {
      key: 'ai_instructions',
      label: 'AI Instructions',
      configKey: 'ai_instructions',
      default: '',
      type: 'multiline',
      description: 'Instructions included in every AI run'
    },
  ];
}

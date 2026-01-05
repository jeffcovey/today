/**
 * Full-screen configuration UI using ink (React for CLIs)
 *
 * Uses htm for JSX-like syntax without requiring transpilation.
 */

import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { TextInput, Select } from '@inkjs/ui';
import htm from 'htm';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { discoverPlugins } from './plugin-loader.js';
import { runPluginsConfigure } from './plugins-configure-ui.js';
import { runDeploymentsConfigure } from './deployments-configure-ui.js';

// Bind htm to React.createElement
const html = htm.bind(React.createElement);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const CONFIG_PATH = path.join(projectRoot, 'config.toml');
const ENV_PATH = path.join(projectRoot, '.env');

// ============================================================================
// Environment variable helpers (using dotenvx for encryption)
// ============================================================================

/**
 * Get an environment variable value (decrypted if encrypted)
 */
function getEnvVar(key) {
  try {
    const result = execSync(`npx dotenvx get ${key} 2>/dev/null`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if an environment variable exists
 */
function hasEnvVar(key) {
  return getEnvVar(key) !== null;
}

/**
 * Set an environment variable (always encrypted)
 */
function setEnvVar(key, value) {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, '# Environment variables for Today\n\n');
  }

  const escapedValue = value.replace(/"/g, '\\"');

  try {
    execSync(`npx dotenvx set ${key} "${escapedValue}"`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    console.error(`Failed to set ${key}:`, error.message);
    return false;
  }
}

// AI provider to env var mapping
const AI_PROVIDER_ENV_VARS = {
  anthropic: { key: 'TODAY_ANTHROPIC_KEY', label: 'Anthropic API Key' },
  'anthropic-api': { key: 'TODAY_ANTHROPIC_KEY', label: 'Anthropic API Key' },
  openai: { key: 'OPENAI_API_KEY', label: 'OpenAI API Key' },
  gemini: { key: 'GOOGLE_API_KEY', label: 'Google API Key' },
  ollama: null, // Local, no key needed
};

/**
 * Editor helper for multi-line fields
 */
function getEditor() {
  return process.env.EDITOR || process.env.VISUAL || 'nano';
}

function editInEditor(currentText, filename = 'edit.txt') {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, filename);
  try {
    fs.writeFileSync(tmpFile, currentText || '');
    const editor = getEditor();
    execSync(`${editor} "${tmpFile}"`, { stdio: 'inherit' });
    const newText = fs.readFileSync(tmpFile, 'utf8');
    fs.unlinkSync(tmpFile);
    return newText.trimEnd();
  } catch (error) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Get available Ollama models by running `ollama list`
 * @returns {Array<{value: string, label: string}>} - Array of model options
 */
function getOllamaModels() {
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
function getModelOptionsForProvider(provider) {
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
 * Configuration sections and fields
 */
const CONFIG_SECTIONS = [
  {
    key: 'general',
    title: 'General Settings',
    fields: [
      { key: 'timezone', label: 'Current Timezone', path: ['timezone'], default: 'America/New_York' },
      { key: 'location', label: 'Current Location', path: ['location'], default: '' },
      { key: 'vault_path', label: 'Vault Path', path: ['vault_path'], default: 'vault', description: 'Path to markdown notes directory (e.g., vault, notes, ~/Obsidian)' },
    ]
  },
  {
    key: 'profile',
    title: 'User Profile',
    fields: [
      { key: 'name', label: 'Name', path: ['profile', 'name'], default: '' },
      { key: 'email', label: 'Email', path: ['profile', 'email'], default: '' },
      { key: 'home_location', label: 'Home Location', path: ['profile', 'home_location'], default: '' },
      { key: 'vocation', label: 'Vocation/Role', path: ['profile', 'vocation'], default: '' },
      { key: 'wake_time', label: 'Wake Time (HH:MM)', path: ['profile', 'wake_time'], default: '06:00' },
      { key: 'bed_time', label: 'Bed Time (HH:MM)', path: ['profile', 'bed_time'], default: '22:00' },
      { key: 'birthdate', label: 'Birthdate (YYYY-MM-DD)', path: ['profile', 'birthdate'], default: '' },
    ]
  },
  {
    key: 'ai',
    title: 'AI Settings',
    fields: [
      {
        key: 'provider',
        label: 'Background Provider',
        path: ['ai', 'provider'],
        default: 'anthropic',
        type: 'select',
        options: [
          { value: 'anthropic', label: 'Anthropic Claude' },
          { value: 'openai', label: 'OpenAI (GPT-4, etc.)' },
          { value: 'ollama', label: 'Ollama (Local models)' },
          { value: 'gemini', label: 'Google Gemini' },
        ],
        description: 'AI for background tasks (summaries, tagging)'
      },
      {
        key: 'api_key',
        label: 'API Key',
        type: 'encrypted',
        dynamic: true, // Label and env var change based on provider
        description: 'API key for the selected provider'
      },
      {
        key: 'model',
        label: 'Background Model',
        path: ['ai', 'model'],
        default: '',
        type: 'dynamic-select',
        getOptions: (config) => getModelOptionsForProvider(config.ai?.provider || 'anthropic'),
        description: 'Model for background tasks'
      },
      {
        key: 'interactive_provider',
        label: 'Interactive Provider',
        path: ['ai', 'interactive_provider'],
        default: 'anthropic',
        type: 'select',
        options: [
          { value: 'anthropic', label: 'Anthropic Claude (uses Claude CLI)' },
          { value: 'anthropic-api', label: 'Anthropic Claude (uses API key)' },
          { value: 'ollama', label: 'Ollama (Local models)' },
          { value: 'openai', label: 'OpenAI (GPT-4, etc.)' },
          { value: 'gemini', label: 'Google Gemini' },
        ],
        description: 'AI for interactive sessions (bin/today)'
      },
      {
        key: 'interactive_model',
        label: 'Interactive Model',
        path: ['ai', 'interactive_model'],
        default: '',
        type: 'dynamic-select',
        getOptions: (config) => getModelOptionsForProvider(config.ai?.interactive_provider || 'anthropic'),
        description: 'Model for interactive sessions'
      },
      {
        key: 'ai_instructions',
        label: 'AI Instructions',
        path: ['ai', 'ai_instructions'],
        default: '',
        type: 'multiline',
        description: 'General instructions included in every AI run'
      },
    ]
  },
  {
    key: 'plugins',
    title: 'Plugins',
    fields: [
      {
        key: 'configure_plugins',
        label: 'Configure data sources',
        type: 'action',
        action: 'openPluginConfig',
        description: 'Open plugin configuration'
      },
    ]
  },
  {
    key: 'deployments',
    title: 'Deployments',
    type: 'dynamic',
    getFields: (config) => {
      const deployments = config.deployments || {};
      const fields = [];

      for (const [provider, providerDeployments] of Object.entries(deployments)) {
        for (const [name, settings] of Object.entries(providerDeployments)) {
          const services = settings.services || {};
          const enabledServices = Object.entries(services)
            .filter(([_, v]) => v === true)
            .map(([k]) => k);
          const statusIcon = settings.enabled !== false ? '✓' : '○';

          fields.push({
            key: `${provider}/${name}`,
            label: `${statusIcon} ${provider}/${name}`,
            type: 'deployment',
            provider,
            name,
            settings,
            description: enabledServices.length > 0
              ? `Services: ${enabledServices.join(', ')}`
              : 'No services enabled'
          });
        }
      }

      fields.push({
        key: '__add_deployment__',
        label: '+ Add deployment',
        type: 'action',
        action: 'addDeployment'
      });

      return fields;
    },
    fields: [] // Will be populated dynamically
  },
];

/**
 * Read config from file
 */
function readConfig() {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    return parseToml(content);
  } catch {
    return {};
  }
}

/**
 * Write config to file
 */
function writeConfig(config) {
  let tomlOutput = stringifyToml(config);

  // Convert ai_instructions to multi-line strings
  tomlOutput = tomlOutput.replace(
    /^(ai_instructions\s*=\s*)"((?:[^"\\]|\\.)*)"/gm,
    (match, prefix, content) => {
      if (!content.includes('\\n')) return match;
      const unescaped = content
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trimEnd(); // Remove trailing whitespace to prevent accumulation
      return `${prefix}"""\n${unescaped}\n"""`;
    }
  );

  const header = `# Configuration for Today system
# Edit this file when your situation changes (e.g., when traveling)

`;

  fs.writeFileSync(CONFIG_PATH, header + tomlOutput);
}

/**
 * Get a value from config using a path array
 */
function getConfigValue(config, pathArr, defaultValue) {
  let value = config;
  for (const key of pathArr) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return defaultValue;
    }
  }
  return value ?? defaultValue;
}

/**
 * Set a value in config using a path array
 */
function setConfigValue(config, pathArr, value) {
  let obj = config;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i];
    if (!(key in obj)) {
      obj[key] = {};
    }
    obj = obj[key];
  }
  obj[pathArr[pathArr.length - 1]] = value;
}

/**
 * Main configuration app component
 */
function ConfigApp({ onAction, initialSection = 0 }) {
  const { exit } = useApp();
  const [config, setConfig] = useState(() => readConfig());
  const [sectionIndex, setSectionIndex] = useState(initialSection);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [mode, setMode] = useState('navigate'); // 'navigate', 'edit', 'select'
  const [editValue, setEditValue] = useState('');

  const section = CONFIG_SECTIONS[sectionIndex];

  // For dynamic sections, compute fields from config; otherwise use static fields
  const sectionFields = section.type === 'dynamic' && section.getFields
    ? section.getFields(config)
    : section.fields;

  const field = sectionFields[fieldIndex];
  const currentValue = field.path ? getConfigValue(config, field.path, field.default) : null;

  // Get current provider for dynamic API key field
  const currentProvider = getConfigValue(config, ['ai', 'provider'], 'anthropic');
  const providerEnvVar = AI_PROVIDER_ENV_VARS[currentProvider];

  // Get dynamic field info for encrypted API key fields
  const getFieldInfo = (f) => {
    if (f.type === 'encrypted' && f.dynamic) {
      if (!providerEnvVar) {
        return { label: 'API Key (not needed for Ollama)', envVar: null, hidden: true };
      }
      return { label: providerEnvVar.label, envVar: providerEnvVar.key, hidden: false };
    }
    return { label: f.label, envVar: null, hidden: false };
  };

  const fieldInfo = getFieldInfo(field);

  // Handle escape key in non-navigate modes
  useInput((input, key) => {
    if (mode === 'navigate') return;

    if (key.escape) {
      setMode('navigate');
    }
  });

  // Handle keyboard input in navigate mode
  useInput((input, key) => {
    if (mode !== 'navigate') return;

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (key.tab) {
      // Move to next section
      setSectionIndex((i) => (i + 1) % CONFIG_SECTIONS.length);
      setFieldIndex(0);
    } else if (key.downArrow || input === 'j') {
      setFieldIndex((i) => Math.min(i + 1, sectionFields.length - 1));
    } else if (key.upArrow || input === 'k') {
      setFieldIndex((i) => Math.max(i - 1, 0));
    } else if (key.return) {
      if (field.type === 'action') {
        // Trigger action callback and exit to allow action to run
        if (onAction) {
          onAction({ type: field.action, returnToSection: sectionIndex });
          exit();
        }
      } else if (field.type === 'deployment') {
        // Open deployment editor
        if (onAction) {
          onAction({
            type: 'editDeployment',
            provider: field.provider,
            name: field.name,
            returnToSection: sectionIndex
          });
          exit();
        }
      } else if (field.type === 'multiline') {
        // Trigger editor action for multiline fields
        if (onAction) {
          onAction({ type: 'openEditor', path: field.path, currentValue: currentValue || '' });
          exit();
        }
      } else if (field.type === 'select' || field.type === 'dynamic-select') {
        setMode('select');
      } else if (field.type === 'encrypted') {
        // Skip if field is hidden (e.g., Ollama doesn't need API key)
        if (fieldInfo.hidden) return;
        // Get current decrypted value for editing
        const decryptedValue = fieldInfo.envVar ? (getEnvVar(fieldInfo.envVar) || '') : '';
        setEditValue(decryptedValue);
        setMode('edit');
      } else {
        setEditValue(String(currentValue || ''));
        setMode('edit');
      }
    }
  });

  // Save a field value
  const saveField = (value) => {
    if (field.type === 'encrypted') {
      // Save encrypted value to .env
      if (fieldInfo.envVar && value) {
        setEnvVar(fieldInfo.envVar, value);
      }
      setMode('navigate');
    } else {
      const newConfig = JSON.parse(JSON.stringify(config)); // Deep clone
      setConfigValue(newConfig, field.path, value);

      // When provider changes, reset the corresponding model to empty (will use default)
      if (field.key === 'provider') {
        setConfigValue(newConfig, ['ai', 'model'], '');
      } else if (field.key === 'interactive_provider') {
        setConfigValue(newConfig, ['ai', 'interactive_model'], '');
      }

      writeConfig(newConfig);
      setConfig(readConfig());
      setMode('navigate');
    }
  };

  // Cancel editing
  const cancelEdit = () => {
    setMode('navigate');
  };

  // Render section tabs
  const tabs = CONFIG_SECTIONS.map((s, i) => {
    const isSelected = i === sectionIndex;
    return html`
      <${Box} key=${'tab-' + s.key} marginRight=${2}>
        <${Text} bold=${isSelected} color=${isSelected ? 'cyan' : 'gray'}>
          ${isSelected ? '▸ ' : '  '}${s.title}
        </${Text}>
      </${Box}>
    `;
  });

  // Render fields list
  const fields = sectionFields.map((f, i) => {
    const isSelected = i === fieldIndex;
    const fInfo = getFieldInfo(f);

    if (f.type === 'action') {
      return html`
        <${Box} key=${'field-' + section.key + '-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>
            ${isSelected ? '▸ ' : '  '}${f.label}
          </${Text}>
          <${Text} dimColor> → Press Enter</${Text}>
        </${Box}>
      `;
    }

    if (f.type === 'deployment') {
      return html`
        <${Box} key=${'field-' + section.key + '-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>
            ${isSelected ? '▸ ' : '  '}${f.label}
          </${Text}>
          <${Text} dimColor> ${f.description}</${Text}>
        </${Box}>
      `;
    }

    // Handle encrypted fields
    if (f.type === 'encrypted') {
      const hasValue = fInfo.envVar ? hasEnvVar(fInfo.envVar) : false;
      const displayValue = fInfo.hidden ? '—' : (hasValue ? '••••••••' : '(not set)');
      const editHint = fInfo.hidden ? '' : ' [encrypted]';

      return html`
        <${Box} key=${'field-' + section.key + '-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'} dimColor=${fInfo.hidden}>
            ${isSelected ? '▸ ' : '  '}${fInfo.label}:
          </${Text}>
          <${Text} color=${fInfo.hidden ? 'gray' : 'green'}> ${displayValue}</${Text}>
          ${isSelected && editHint ? html`<${Text} dimColor>${editHint}</${Text}>` : null}
        </${Box}>
      `;
    }

    const value = getConfigValue(config, f.path, f.default);
    let displayValue;
    let editHint = '';

    if (f.type === 'select') {
      displayValue = f.options?.find(o => o.value === value)?.label || value;
    } else if (f.type === 'dynamic-select') {
      const dynamicOptions = f.getOptions ? f.getOptions(config) : [];
      displayValue = dynamicOptions?.find(o => o.value === value)?.label || value || '(provider default)';
    } else if (f.type === 'multiline') {
      const lines = String(value || '').split('\n');
      displayValue = value
        ? (lines.length > 1 ? `${lines[0].slice(0, 30)}... (${lines.length} lines)` : lines[0].slice(0, 50))
        : '(not set)';
      editHint = ' [opens editor]';
    } else {
      displayValue = value;
    }

    return html`
      <${Box} key=${'field-' + section.key + '-' + f.key}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>
          ${isSelected ? '▸ ' : '  '}${f.label}:
        </${Text}>
        <${Text} color="green"> ${displayValue || '(not set)'}</${Text}>
        ${isSelected && editHint ? html`<${Text} dimColor>${editHint}</${Text}>` : null}
      </${Box}>
    `;
  });

  // Edit mode UI
  const editUI = mode === 'edit' ? html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <${Text} bold color="yellow">${fieldInfo.label}</${Text}>
      <${Box} marginTop=${1}>
        <${TextInput}
          defaultValue=${editValue}
          onSubmit=${saveField}
          placeholder=${field.type === 'encrypted' ? 'Enter API key...' : 'Enter value...'}
        />
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>Press Enter to save</${Text}>
      </${Box}>
    </${Box}>
  ` : null;

  // Select mode UI - get options (static or dynamic)
  const selectOptions = field.type === 'dynamic-select' && field.getOptions
    ? field.getOptions(config)
    : field.options;

  const selectUI = mode === 'select' ? html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <${Text} bold color="yellow">${field.label}</${Text}>
      <${Box} marginTop=${1}>
        <${Select}
          options=${selectOptions}
          defaultValue=${currentValue}
          onChange=${saveField}
        />
      </${Box}>
    </${Box}>
  ` : null;

  // Help bar text
  const helpText = mode === 'navigate'
    ? 'Tab: switch section │ ↑↓/jk: navigate │ Enter: edit │ q: quit'
    : 'Enter: save │ Esc: cancel';

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Box} marginBottom=${1}>
        <${Text} bold color="white">Today Configuration</${Text}>
      </${Box}>

      <${Box} marginBottom=${1}>
        ${tabs}
      </${Box}>

      <${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1}>
        <${Box} marginBottom=${1}>
          <${Text} bold color="white">${section.title}</${Text}>
        </${Box}>
        ${fields}
      </${Box}>

      ${editUI}
      ${selectUI}

      <${Box} marginTop=${1}>
        <${Text} dimColor>${helpText}</${Text}>
      </${Box}>
    </${Box}>
  `;
}

/**
 * Set a value in config using a path array (for use by runConfigure)
 */
function setConfigValueAndSave(pathArr, value) {
  const config = readConfig();
  let obj = config;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i];
    if (!(key in obj)) {
      obj[key] = {};
    }
    obj = obj[key];
  }
  if (value === '' || value === null || value === undefined) {
    delete obj[pathArr[pathArr.length - 1]];
  } else {
    obj[pathArr[pathArr.length - 1]] = value;
  }
  writeConfig(config);
}

export async function runConfigure() {
  let pendingAction = null;
  let currentSection = 0;

  while (true) {
    // Create action handler that stores action and exits
    const handleAction = (action) => {
      pendingAction = action;
    };

    const { waitUntilExit } = render(html`<${ConfigApp} onAction=${handleAction} initialSection=${currentSection} />`);
    await waitUntilExit();

    // Handle any pending action
    if (pendingAction?.type === 'openPluginConfig') {
      currentSection = pendingAction.returnToSection ?? currentSection;
      pendingAction = null;
      const plugins = await discoverPlugins();
      await runPluginsConfigure(plugins);
      // Loop continues - will re-render ConfigApp at same section
    } else if (pendingAction?.type === 'editDeployment') {
      currentSection = pendingAction.returnToSection ?? currentSection;
      const { provider, name } = pendingAction;
      pendingAction = null;
      await runDeploymentsConfigure({ editDeployment: { provider, name } });
      // Loop continues - will re-render ConfigApp at same section
    } else if (pendingAction?.type === 'addDeployment') {
      currentSection = pendingAction.returnToSection ?? currentSection;
      pendingAction = null;
      await runDeploymentsConfigure({ addNew: true });
      // Loop continues - will re-render ConfigApp at same section
    } else if (pendingAction?.type === 'openEditor') {
      const { path: fieldPath, currentValue } = pendingAction;
      pendingAction = null;

      // Open editor
      const filename = `${fieldPath.join('-')}.txt`;
      const newValue = editInEditor(currentValue || '', filename);

      // Save if editor returned a value (not cancelled)
      if (newValue !== null) {
        setConfigValueAndSave(fieldPath, newValue);
      }

      // Loop continues - will re-render ConfigApp
    } else {
      // No action or quit - exit the loop
      break;
    }
  }

  console.log('\n✓ Configuration complete.\n');
}

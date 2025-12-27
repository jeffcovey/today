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
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { discoverPlugins } from './plugin-loader.js';
import { runPluginsConfigure } from './plugins-configure-ui.js';

// Bind htm to React.createElement
const html = htm.bind(React.createElement);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const CONFIG_PATH = path.join(projectRoot, 'config.toml');

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
    ]
  },
  {
    key: 'ai',
    title: 'AI Settings',
    fields: [
      {
        key: 'claude_model',
        label: 'Claude Model',
        path: ['ai', 'claude_model'],
        default: 'claude-sonnet-4-20250514',
        type: 'select',
        options: [
          { value: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Most capable)' },
          { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Recommended)' },
          { value: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5 (Fastest)' },
        ]
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
function ConfigApp({ onAction }) {
  const { exit } = useApp();
  const [config, setConfig] = useState(() => readConfig());
  const [sectionIndex, setSectionIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [mode, setMode] = useState('navigate'); // 'navigate', 'edit', 'select'
  const [editValue, setEditValue] = useState('');

  const section = CONFIG_SECTIONS[sectionIndex];
  const field = section.fields[fieldIndex];
  const currentValue = field.path ? getConfigValue(config, field.path, field.default) : null;

  // Handle keyboard input
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
      setFieldIndex((i) => Math.min(i + 1, section.fields.length - 1));
    } else if (key.upArrow || input === 'k') {
      setFieldIndex((i) => Math.max(i - 1, 0));
    } else if (key.return) {
      if (field.type === 'action') {
        // Trigger action callback and exit to allow action to run
        if (onAction) {
          onAction(field.action);
          exit();
        }
      } else if (field.type === 'select') {
        setMode('select');
      } else {
        setEditValue(String(currentValue || ''));
        setMode('edit');
      }
    }
  });

  // Save a field value
  const saveField = (value) => {
    const newConfig = JSON.parse(JSON.stringify(config)); // Deep clone
    setConfigValue(newConfig, field.path, value);
    writeConfig(newConfig);
    setConfig(readConfig());
    setMode('navigate');
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
  const fields = section.fields.map((f, i) => {
    const isSelected = i === fieldIndex;

    if (f.type === 'action') {
      return html`
        <${Box} key=${'field-' + section.key + '-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>
            ${isSelected ? '▸ ' : '  '}${f.label}
          </${Text}>
          <${Text} dimColor> → Press Enter to open</${Text}>
        </${Box}>
      `;
    }

    const value = getConfigValue(config, f.path, f.default);
    const displayValue = f.type === 'select'
      ? (f.options?.find(o => o.value === value)?.label || value)
      : value;

    return html`
      <${Box} key=${'field-' + section.key + '-' + f.key}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>
          ${isSelected ? '▸ ' : '  '}${f.label}:
        </${Text}>
        <${Text} color="green"> ${displayValue || '(not set)'}</${Text}>
      </${Box}>
    `;
  });

  // Edit mode UI
  const editUI = mode === 'edit' ? html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <${Text} bold color="yellow">${field.label}</${Text}>
      <${Box} marginTop=${1}>
        <${TextInput}
          defaultValue=${editValue}
          onSubmit=${saveField}
          placeholder="Enter value..."
        />
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>Press Enter to save</${Text}>
      </${Box}>
    </${Box}>
  ` : null;

  // Select mode UI
  const selectUI = mode === 'select' ? html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <${Text} bold color="yellow">${field.label}</${Text}>
      <${Box} marginTop=${1}>
        <${Select}
          options=${field.options}
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
 * Run the configuration UI
 */
export async function runConfigure() {
  let pendingAction = null;

  while (true) {
    // Create action handler that stores action and exits
    const handleAction = (action) => {
      pendingAction = action;
    };

    const { waitUntilExit, unmount } = render(html`<${ConfigApp} onAction=${handleAction} />`);
    await waitUntilExit();

    // Handle any pending action
    if (pendingAction === 'openPluginConfig') {
      pendingAction = null;
      const plugins = await discoverPlugins();
      await runPluginsConfigure(plugins);
      // Loop continues - will re-render ConfigApp
    } else {
      // No action or quit - exit the loop
      break;
    }
  }

  console.log('\n✓ Configuration complete.\n');
}

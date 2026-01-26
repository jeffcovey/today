/**
 * Full-screen plugin configuration UI using ink (React for CLIs)
 *
 * Two-level navigation:
 * 1. Main menu: List of plugins
 * 2. Submenu: Sources for selected plugin
 */

import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { TextInput, Select, ConfirmInput } from '@inkjs/ui';
import htm from 'htm';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { schemas } from './plugin-schemas.js';
import { getConfigPath } from './config.js';

const html = htm.bind(React.createElement);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const CONFIG_PATH = getConfigPath();
const ENV_PATH = path.join(projectRoot, '.env');

// ============================================================================
// Environment variable helpers (using dotenvx for encryption)
// ============================================================================

/**
 * Get an environment variable value (decrypted if encrypted)
 * @param {string} key - Environment variable name
 * @returns {string|null} - Decrypted value or null if not set
 */
function getEnvVar(key) {
  try {
    const result = execSync(`npx dotenvx get ${key} 2>/dev/null`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Set an environment variable (always encrypted)
 * Creates .env file if it doesn't exist
 * dotenvx automatically creates .env.keys on first encryption
 * @param {string} key - Environment variable name
 * @param {string} value - Value to set
 * @returns {boolean} - True if successful
 */
function setEnvVar(key, value) {
  // Create .env if it doesn't exist
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, '# Environment variables for Today\n\n');
  }

  // Escape the value for shell
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');

  try {
    // dotenvx set encrypts by default and creates .env.keys if needed
    execSync(`npx dotenvx set ${key} "${escapedValue}"`, {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    // Log error for debugging
    console.error(`Failed to set ${key}:`, error.message);
    return false;
  }
}

/**
 * Check if an environment variable is set
 * @param {string} key - Environment variable name
 * @returns {boolean}
 */
function hasEnvVar(key) {
  return getEnvVar(key) !== null;
}

// ============================================================================
// Editor helper for multi-line fields
// ============================================================================

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

// ============================================================================
// Config helpers
// ============================================================================

function readConfig() {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    return parseToml(content);
  } catch {
    return {};
  }
}

function writeConfig(config) {
  let tomlOutput = stringifyToml(config);
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

function getPluginSources(pluginName) {
  const config = readConfig();
  return config.plugins?.[pluginName] || {};
}

function toggleSource(pluginName, sourceName, enabled) {
  const config = readConfig();
  if (!config.plugins) config.plugins = {};
  if (!config.plugins[pluginName]) config.plugins[pluginName] = {};
  if (!config.plugins[pluginName][sourceName]) config.plugins[pluginName][sourceName] = {};
  config.plugins[pluginName][sourceName].enabled = enabled;
  writeConfig(config);
}

function deleteSource(pluginName, sourceName) {
  const config = readConfig();
  if (config.plugins?.[pluginName]?.[sourceName]) {
    delete config.plugins[pluginName][sourceName];
    if (Object.keys(config.plugins[pluginName]).length === 0) {
      delete config.plugins[pluginName];
    }
    writeConfig(config);
  }
}

function updateSourceField(pluginName, sourceName, fieldName, value) {
  const config = readConfig();
  if (!config.plugins) config.plugins = {};
  if (!config.plugins[pluginName]) config.plugins[pluginName] = {};
  if (!config.plugins[pluginName][sourceName]) config.plugins[pluginName][sourceName] = {};
  if (value === '' || value === null || value === undefined) {
    delete config.plugins[pluginName][sourceName][fieldName];
  } else {
    config.plugins[pluginName][sourceName][fieldName] = value;
  }
  writeConfig(config);
}

function createSource(pluginName, sourceName) {
  const config = readConfig();
  if (!config.plugins) config.plugins = {};
  if (!config.plugins[pluginName]) config.plugins[pluginName] = {};
  config.plugins[pluginName][sourceName] = { enabled: true };
  writeConfig(config);
}

// Function to get available calendar sources for dropdowns
function getAvailableCalendarSources() {
  const config = readConfig();
  const sources = [];

  if (config.plugins && config.plugins['public-calendars']) {
    for (const sourceName of Object.keys(config.plugins['public-calendars'])) {
      sources.push({
        value: `public-calendars/${sourceName}`,
        label: `public-calendars/${sourceName}`
      });
    }
  }

  // Add empty option for "none"
  sources.unshift({ value: '', label: '(none)' });

  return sources;
}

// ============================================================================
// Build plugin list for main menu
// ============================================================================

/**
 * Get display label for a plugin type
 * Uses the AI name from schema, or falls back to capitalized type name
 */
function getTypeDisplayLabel(type) {
  const schema = schemas[type];
  if (schema?.ai?.name) {
    return schema.ai.name;
  }
  // Fallback: capitalize and replace hyphens
  return type.split('-').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
}

/**
 * Get all plugin types from schemas, sorted alphabetically
 * Excludes utility type (no AI context)
 */
function getOrderedPluginTypes() {
  const allTypes = Object.keys(schemas);
  return allTypes.filter(type => type !== 'utility').sort();
}

function buildPluginList(plugins) {
  const config = readConfig();
  const byType = {};

  for (const [pluginName, plugin] of plugins) {
    const sources = config.plugins?.[pluginName] || {};
    const sourceNames = Object.keys(sources);
    const enabledCount = sourceNames.filter(s => sources[s].enabled).length;
    const type = plugin.type || 'other';

    if (!byType[type]) byType[type] = [];
    byType[type].push({
      name: pluginName,
      plugin: { ...plugin, name: pluginName },
      sourceCount: sourceNames.length,
      enabledCount,
      type,
    });
  }

  // Sort each type's plugins
  for (const type of Object.keys(byType)) {
    byType[type].sort((a, b) => {
      if (a.enabledCount > 0 && b.enabledCount === 0) return -1;
      if (b.enabledCount > 0 && a.enabledCount === 0) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Build flat list with headers
  const displayList = [];
  const pluginIndexMap = []; // Maps display index to plugin (null for headers)

  for (const type of getOrderedPluginTypes()) {
    if (!byType[type] || byType[type].length === 0) continue;

    // Add type header
    displayList.push({ type: 'header', label: getTypeDisplayLabel(type) });
    pluginIndexMap.push(null);

    // Add plugins
    for (const p of byType[type]) {
      displayList.push({ type: 'plugin', plugin: p });
      pluginIndexMap.push(p);
    }
  }

  return { displayList, pluginIndexMap };
}

// ============================================================================
// Build source list for submenu
// ============================================================================

function buildSourceList(pluginName, plugin) {
  const sources = getPluginSources(pluginName);
  const list = [];

  for (const [sourceName, sourceConfig] of Object.entries(sources)) {
    list.push({
      sourceName,
      enabled: sourceConfig.enabled === true,
      config: sourceConfig,
    });
  }

  // Sort: enabled first, then by name
  list.sort((a, b) => {
    if (a.enabled && !b.enabled) return -1;
    if (b.enabled && !a.enabled) return 1;
    return a.sourceName.localeCompare(b.sourceName);
  });

  return list;
}

// ============================================================================
// Edit source dialog
// ============================================================================

/**
 * Generate a unique environment variable name for encrypted settings
 * @param {string} pluginName - Plugin name (e.g., "imap-email")
 * @param {string} sourceName - Source name (e.g., "personal")
 * @param {string} settingKey - Setting key (e.g., "password")
 * @returns {string} Environment variable name (e.g., "TODAY_IMAP_EMAIL_PERSONAL_PASSWORD")
 */
function getEncryptedEnvVarName(pluginName, sourceName, settingKey) {
  const sanitize = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `TODAY_${sanitize(pluginName)}_${sanitize(sourceName)}_${sanitize(settingKey)}`;
}

function EditSourceDialog({ pluginName, sourceName, plugin, sourceConfig, onSave, onCancel, onOpenEditor, onEncryptedSave }) {
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [selecting, setSelecting] = useState(false);

  const settings = plugin.settings || {};

  const fields = [
    { key: 'enabled', label: 'Enabled', type: 'boolean', value: sourceConfig.enabled === true },
  ];

  for (const [key, def] of Object.entries(settings)) {
    if (def.encrypted) {
      // Encrypted setting - stored in .env, not config.toml
      const envVarName = getEncryptedEnvVarName(pluginName, sourceName, key);
      const hasValue = hasEnvVar(envVarName);
      fields.push({
        key,
        label: def.description || key,
        type: 'encrypted',
        required: def.required || false,
        value: hasValue ? '********' : '',
        envVarName,
      });
    } else if (def.type === 'select') {
      // Select field - get options dynamically if needed
      let options = def.options || [];
      if (key === 'calendar_source') {
        // Special case: get available calendar sources
        options = getAvailableCalendarSources();
      }
      fields.push({
        key,
        label: def.description || key,
        type: 'select',
        required: def.required || false,
        value: sourceConfig[key] ?? def.default ?? '',
        options: options,
      });
    } else {
      fields.push({
        key,
        label: def.description || key,
        type: def.type || 'string',
        required: def.required || false,
        value: sourceConfig[key] ?? def.default ?? '',
      });
    }
  }

  // Add ai_instructions as the last field (available for all sources)
  fields.push({
    key: 'ai_instructions',
    label: 'AI Instructions',
    type: 'multiline',
    value: sourceConfig.ai_instructions || '',
  });

  const currentField = fields[fieldIndex];

  useInput((input, key) => {
    if (editing || selecting) {
      if (key.escape) {
        setEditing(false);
        setSelecting(false);
      }
      return;
    }
    if (key.escape || input === 'q') {
      onCancel();
    } else if (key.downArrow || input === 'j') {
      setFieldIndex(i => Math.min(i + 1, fields.length - 1));
    } else if (key.upArrow || input === 'k') {
      setFieldIndex(i => Math.max(i - 1, 0));
    } else if (key.return) {
      if (currentField.type === 'boolean') {
        onSave(currentField.key, !currentField.value);
      } else if (currentField.type === 'select') {
        setSelecting(true);
      } else if (currentField.type === 'multiline') {
        // Open external editor for multiline fields
        if (onOpenEditor) {
          onOpenEditor(currentField.key, currentField.value);
        }
      } else if (currentField.type === 'encrypted') {
        // For encrypted settings, decrypt and show the actual value for editing
        const decryptedValue = getEnvVar(currentField.envVarName) || '';
        setEditValue(decryptedValue);
        setEditing(true);
      } else {
        setEditValue(String(currentField.value || ''));
        setEditing(true);
      }
    }
  });

  const handleSubmit = (value) => {
    if (currentField.type === 'encrypted') {
      // Save encrypted setting to .env
      if (onEncryptedSave) {
        onEncryptedSave(currentField.envVarName, value);
      }
    } else {
      onSave(currentField.key, value);
    }
    setEditing(false);
  };

  const fieldRows = fields.map((f, i) => {
    const isSelected = i === fieldIndex;
    let displayValue;
    if (f.type === 'boolean') {
      displayValue = f.value ? 'Yes' : 'No';
    } else if (f.type === 'select') {
      // Show option label for select fields
      const option = f.options?.find(opt => opt.value === f.value);
      displayValue = option ? option.label : (f.value || '(not set)');
    } else if (f.type === 'multiline') {
      // Show truncated preview for multiline
      const lines = String(f.value || '').split('\n');
      displayValue = f.value
        ? (lines.length > 1 ? `${lines[0].slice(0, 30)}... (${lines.length} lines)` : lines[0].slice(0, 50))
        : '(not set)';
    } else if (f.type === 'encrypted') {
      // Show masked value for encrypted settings
      displayValue = f.value || '(not set)';
    } else {
      displayValue = f.value || '(not set)';
    }
    const editHint = f.type === 'multiline' ? ' [opens editor]' : (f.type === 'encrypted' ? ' [encrypted]' : (f.type === 'select' ? ' [select]' : ''));
    return html`
      <${Box} key=${'field-' + f.key}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}${f.label}: </Text>
        <${Text} color="green">${displayValue}</Text>
        ${isSelected && editHint ? html`<${Text} dimColor>${editHint}</Text>` : null}
        ${f.required ? html`<${Text} color="red"> *</Text>` : null}
      </Box>
    `;
  });

  return html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
      <${Text} bold color="cyan">Edit: ${sourceName}</Text>
      <${Box} marginTop=${1} flexDirection="column">${fieldRows}</Box>
      ${editing ? html`
        <${Box} marginTop=${1} borderStyle="single" borderColor="yellow" paddingX=${1} flexDirection="column">
          <${Text} color="yellow">${currentField.label}</Text>
          <${TextInput} defaultValue=${editValue} onSubmit=${handleSubmit} placeholder="Enter value..." />
        </Box>
      ` : selecting && currentField.type === 'select' ? html`
        <${Box} marginTop=${1} borderStyle="single" borderColor="green" paddingX=${1} flexDirection="column">
          <${Text} color="green">${currentField.label}</Text>
          <${Select}
            options=${currentField.options}
            defaultValue=${currentField.value}
            onChange=${(value) => {
              onSave(currentField.key, value);
              setSelecting(false);
            }}
          />
        </Box>
      ` : html`
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: edit │ Esc: back</Text>
        </Box>
      `}
    </Box>
  `;
}

// ============================================================================
// Add source dialog
// ============================================================================

function AddSourceDialog({ pluginName, existingSources, onAdd, onCancel }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  const handleSubmit = (value) => {
    const trimmed = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (existingSources.includes(trimmed)) {
      setError('Source already exists');
      return;
    }
    onAdd(trimmed);
  };

  return html`
    <${Box} flexDirection="column" borderStyle="single" borderColor="green" paddingX=${1}>
      <${Text} bold color="green">Add New Source</Text>
      <${Box} marginTop=${1}>
        <${Text}>Source name: </Text>
        <${TextInput} defaultValue=${name} onSubmit=${handleSubmit} placeholder="e.g., work, personal" />
      </Box>
      ${error ? html`<${Text} color="red">${error}</Text>` : null}
      <${Box} marginTop=${1}>
        <${Text} dimColor>Enter: create │ Esc: cancel</Text>
      </Box>
    </Box>
  `;
}

// ============================================================================
// Source list submenu
// ============================================================================

function SourceListView({ pluginName, plugin, onBack, visibleHeight, onEditorRequest }) {
  const [sources, setSources] = useState(() => buildSourceList(pluginName, plugin));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState('list'); // 'list', 'edit', 'add', 'delete'
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusPanel, setFocusPanel] = useState('sources'); // 'sources' or 'info'
  const [infoScrollOffset, setInfoScrollOffset] = useState(0);

  const refreshSources = () => setSources(buildSourceList(pluginName, plugin));
  const selectedSource = sources[selectedIndex];

  // Build description content as lines for scrolling
  const description = plugin.description || '';
  const longDescription = (plugin.longDescription || '').trim();
  const fullDescription = description + (longDescription ? '\n\n' + longDescription : '');
  const descriptionLines = fullDescription.split('\n');

  // Calculate available heights
  const listHeight = Math.max(3, visibleHeight - 4);
  const infoHeight = Math.max(3, visibleHeight - 4);
  const maxInfoScroll = Math.max(0, descriptionLines.length - infoHeight);

  useInput((input, key) => {
    if (mode !== 'list') return;

    if (key.escape || input === 'q') {
      onBack();
    } else if (key.tab) {
      // Toggle focus between panels
      setFocusPanel(focusPanel === 'sources' ? 'info' : 'sources');
    } else if (focusPanel === 'sources') {
      // Source list navigation
      if (key.downArrow || input === 'j') {
        if (selectedIndex < sources.length - 1) {
          setSelectedIndex(selectedIndex + 1);
          if (selectedIndex + 1 >= scrollOffset + listHeight) {
            setScrollOffset(scrollOffset + 1);
          }
        }
      } else if (key.upArrow || input === 'k') {
        if (selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
          if (selectedIndex - 1 < scrollOffset) {
            setScrollOffset(scrollOffset - 1);
          }
        }
      } else if (input === ' ' && selectedSource) {
        toggleSource(pluginName, selectedSource.sourceName, !selectedSource.enabled);
        refreshSources();
      } else if (key.return && selectedSource) {
        setMode('edit');
      } else if (input === 'a') {
        setMode('add');
      } else if (input === 'd' && selectedSource) {
        setMode('delete');
      }
    } else if (focusPanel === 'info') {
      // Info panel scrolling
      if (key.downArrow || input === 'j') {
        setInfoScrollOffset(Math.min(infoScrollOffset + 1, maxInfoScroll));
      } else if (key.upArrow || input === 'k') {
        setInfoScrollOffset(Math.max(infoScrollOffset - 1, 0));
      } else if (key.pageDown) {
        setInfoScrollOffset(Math.min(infoScrollOffset + infoHeight, maxInfoScroll));
      } else if (key.pageUp) {
        setInfoScrollOffset(Math.max(infoScrollOffset - infoHeight, 0));
      }
    }
  });

  const handleEditSave = (fieldKey, value) => {
    if (fieldKey === 'enabled') {
      toggleSource(pluginName, selectedSource.sourceName, value);
    } else {
      updateSourceField(pluginName, selectedSource.sourceName, fieldKey, value);
    }
    refreshSources();
  };

  const handleAddSource = (sourceName) => {
    createSource(pluginName, sourceName);
    refreshSources();
    // Find the index of the newly created source and select it
    const newSources = buildSourceList(pluginName, plugin);
    const newIndex = newSources.findIndex(s => s.sourceName === sourceName);
    if (newIndex >= 0) {
      setSelectedIndex(newIndex);
      setSources(newSources);
    }
    // Go straight to edit mode for the new source
    setMode('edit');
  };

  const handleOpenEditor = (fieldKey, currentValue) => {
    if (onEditorRequest) {
      onEditorRequest({
        pluginName,
        sourceName: selectedSource.sourceName,
        fieldKey,
        currentValue,
      });
    }
  };

  const handleEncryptedSave = (envVarName, value) => {
    if (value) {
      setEnvVar(envVarName, value);
    }
    refreshSources();
  };

  if (mode === 'edit' && selectedSource) {
    return html`
      <${EditSourceDialog}
        pluginName=${pluginName}
        sourceName=${selectedSource.sourceName}
        plugin=${plugin}
        sourceConfig=${selectedSource.config}
        onSave=${handleEditSave}
        onCancel=${() => setMode('list')}
        onOpenEditor=${handleOpenEditor}
        onEncryptedSave=${handleEncryptedSave}
      />
    `;
  }

  if (mode === 'add') {
    return html`
      <${AddSourceDialog}
        pluginName=${pluginName}
        existingSources=${sources.map(s => s.sourceName)}
        onAdd=${handleAddSource}
        onCancel=${() => setMode('list')}
      />
    `;
  }

  if (mode === 'delete' && selectedSource) {
    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="red" paddingX=${1}>
        <${Text} bold color="red">Delete "${selectedSource.sourceName}"?</Text>
        <${Box} marginTop=${1}>
          <${ConfirmInput}
            onConfirm=${() => {
              deleteSource(pluginName, selectedSource.sourceName);
              refreshSources();
              setSelectedIndex(Math.max(0, selectedIndex - 1));
              setMode('list');
            }}
            onCancel=${() => setMode('list')}
          />
        </Box>
      </Box>
    `;
  }

  // Source list with scroll indicators
  const hasMoreSourcesAbove = scrollOffset > 0;
  const hasMoreSourcesBelow = scrollOffset + listHeight < sources.length;
  const sourceIndicators = (hasMoreSourcesAbove ? 1 : 0) + (hasMoreSourcesBelow ? 1 : 0);
  const effectiveListHeight = Math.max(1, listHeight - sourceIndicators);
  const visibleSources = sources.slice(scrollOffset, scrollOffset + effectiveListHeight);

  const sourceRows = visibleSources.map((s, i) => {
    const actualIndex = scrollOffset + i;
    const isSelected = actualIndex === selectedIndex;
    const status = s.enabled ? '✓' : '○';
    const statusColor = s.enabled ? 'green' : 'gray';
    return html`
      <${Box} key=${'source-' + actualIndex + '-' + s.sourceName}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}</Text>
        <${Text} color=${statusColor}>${status} </Text>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>${s.sourceName}</Text>
      </Box>
    `;
  });

  // Info panel with scroll indicators
  const hasMoreInfoAbove = infoScrollOffset > 0;
  const hasMoreInfoBelow = infoScrollOffset + infoHeight < descriptionLines.length;
  const infoIndicators = (hasMoreInfoAbove ? 1 : 0) + (hasMoreInfoBelow ? 1 : 0);
  const effectiveInfoHeight = Math.max(1, infoHeight - infoIndicators);
  const visibleDescLines = descriptionLines.slice(infoScrollOffset, infoScrollOffset + effectiveInfoHeight);

  const displayName = plugin.displayName || pluginName;
  const sourceBorderColor = focusPanel === 'sources' ? 'cyan' : 'gray';
  const infoBorderColor = focusPanel === 'info' ? 'cyan' : 'gray';

  return html`
    <${Box} flexDirection="column">
      <${Box} marginBottom=${1}>
        <${Text} bold color="cyan">${displayName}</Text>
        <${Text} dimColor> - Sources (${sources.length})</Text>
      </Box>

      <${Box} flexDirection="row" height=${visibleHeight}>
        <${Box} flexDirection="column" borderStyle="single" borderColor=${sourceBorderColor} paddingX=${1} width="40%">
          ${sources.length === 0 ? html`
            <${Text} dimColor>No sources configured.</Text>
            <${Text} dimColor>Press 'a' to add one.</Text>
          ` : html`
            <${React.Fragment}>
              ${hasMoreSourcesAbove ? html`<${Text} color="cyan">  ▲ more</Text>` : null}
              ${sourceRows}
              ${hasMoreSourcesBelow ? html`<${Text} color="cyan">  ▼ more</Text>` : null}
            </React.Fragment>
          `}
        </Box>

        <${Box} flexDirection="column" borderStyle="single" borderColor=${infoBorderColor} paddingX=${1} marginLeft=${1} width="60%">
          ${hasMoreInfoAbove ? html`<${Text} color="cyan">▲ more</Text>` : null}
          ${visibleDescLines.map((line, i) => html`
            <${Text} key=${'desc-' + (infoScrollOffset + i)} wrap="wrap" dimColor=${focusPanel !== 'info'}>${line || ' '}</Text>
          `)}
          ${hasMoreInfoBelow ? html`<${Text} color="cyan">▼ more</Text>` : null}
        </Box>
      </Box>

      <${Box} marginTop=${1}>
        <${Text} dimColor>Tab: switch panel │ ↑↓: ${focusPanel === 'sources' ? 'navigate' : 'scroll'} │ Space: toggle │ Enter: edit │ a: add │ d: delete │ Esc: back</Text>
      </Box>
    </Box>
  `;
}

// ============================================================================
// Main plugin list
// ============================================================================

function PluginsConfigApp({ plugins, onEditorRequest }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [listData, setListData] = useState(() => buildPluginList(plugins));
  const [selectedIndex, setSelectedIndex] = useState(() => {
    // Start on first selectable item (skip header)
    const { pluginIndexMap } = buildPluginList(plugins);
    return pluginIndexMap.findIndex(p => p !== null);
  });
  const [selectedPlugin, setSelectedPlugin] = useState(null);
  const [scrollOffset, setScrollOffset] = useState(0);

  const { displayList, pluginIndexMap } = listData;
  const terminalHeight = stdout?.rows || 24;
  const visibleHeight = Math.max(5, terminalHeight - 8);

  const refreshPlugins = () => setListData(buildPluginList(plugins));

  // Find next selectable index (skipping headers)
  const findNextSelectable = (from, direction) => {
    let idx = from + direction;
    while (idx >= 0 && idx < displayList.length) {
      if (pluginIndexMap[idx] !== null) return idx;
      idx += direction;
    }
    return from; // Stay on current if no selectable found
  };

  // Count only selectable items for display
  const selectableCount = pluginIndexMap.filter(p => p !== null).length;
  const currentSelectableNum = pluginIndexMap.slice(0, selectedIndex + 1).filter(p => p !== null).length;

  useInput((input, key) => {
    if (selectedPlugin) return; // Submenu handles input

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (key.downArrow || input === 'j') {
      const next = findNextSelectable(selectedIndex, 1);
      if (next !== selectedIndex) {
        setSelectedIndex(next);
        // Calculate effective visible height (accounting for scroll indicators)
        const hasBelow = scrollOffset + visibleHeight < displayList.length;
        const hasAbove = scrollOffset > 0;
        const indicators = (hasBelow ? 1 : 0) + (hasAbove ? 1 : 0);
        const effHeight = Math.max(3, visibleHeight - indicators);
        if (next >= scrollOffset + effHeight) {
          setScrollOffset(next - effHeight + 1);
        }
      }
    } else if (key.upArrow || input === 'k') {
      const prev = findNextSelectable(selectedIndex, -1);
      if (prev !== selectedIndex) {
        setSelectedIndex(prev);
        if (prev < scrollOffset) {
          setScrollOffset(prev);
        }
      }
    } else if (key.return) {
      const plugin = pluginIndexMap[selectedIndex];
      if (plugin) {
        setSelectedPlugin(plugin);
      }
    }
  });

  const handleBack = () => {
    setSelectedPlugin(null);
    refreshPlugins();
  };

  const handleEditorRequest = (request) => {
    if (onEditorRequest) {
      onEditorRequest(request);
      exit();
    }
  };

  // Show submenu if a plugin is selected
  if (selectedPlugin) {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${SourceListView}
          pluginName=${selectedPlugin.name}
          plugin=${selectedPlugin.plugin}
          onBack=${handleBack}
          visibleHeight=${visibleHeight}
          onEditorRequest=${handleEditorRequest}
        />
      </Box>
    `;
  }

  // Main plugin list - account for scroll indicators
  const hasMoreAbove = scrollOffset > 0;
  const hasMoreBelow = scrollOffset + visibleHeight < displayList.length;
  const indicatorRows = (hasMoreAbove ? 1 : 0) + (hasMoreBelow ? 1 : 0);
  const effectiveHeight = Math.max(3, visibleHeight - indicatorRows);
  const visibleItems = displayList.slice(scrollOffset, scrollOffset + effectiveHeight);
  const currentPlugin = pluginIndexMap[selectedIndex];
  const description = currentPlugin?.plugin?.description || '';
  const longDescription = currentPlugin?.plugin?.longDescription || '';

  // Truncate long description
  const maxDescLines = Math.max(3, visibleHeight - 4);
  const descLines = (longDescription || '').trim().split('\n');
  const truncatedDesc = descLines.length > maxDescLines
    ? descLines.slice(0, maxDescLines).join('\n') + '\n...'
    : (longDescription || '').trim();

  // Build rows from displayList
  const itemRows = visibleItems.map((item, i) => {
    const actualIndex = scrollOffset + i;

    if (item.type === 'header') {
      return html`
        <${Box} key=${'row-' + actualIndex + '-header'}>
          <${Text} color="yellow" bold>── ${item.label} ──</Text>
        </Box>
      `;
    }

    const p = item.plugin;
    const isSelected = actualIndex === selectedIndex;
    const displayName = p.plugin.displayName || p.name;
    const sourceInfo = p.enabledCount > 0
      ? `${p.enabledCount} on`
      : (p.sourceCount > 0 ? 'off' : '');
    const sourceColor = p.enabledCount > 0 ? 'green' : 'gray';

    return html`
      <${Box} key=${'row-' + actualIndex + '-' + p.name}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}${displayName}</Text>
        ${sourceInfo ? html`<${Text} color=${sourceColor}> (${sourceInfo})</Text>` : null}
      </Box>
    `;
  });

  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Box} marginBottom=${1}>
        <${Text} bold color="white">Plugin Configuration</Text>
        <${Text} dimColor>  (${currentSelectableNum}/${selectableCount})</Text>
      </Box>

      <${Box} flexDirection="row" height=${visibleHeight + 2}>
        <${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1} width="50%">
          ${hasMoreAbove ? html`<${Text} color="cyan">  ▲ more</Text>` : null}
          ${itemRows}
          ${hasMoreBelow ? html`<${Text} color="cyan">  ▼ more</Text>` : null}
        </Box>

        <${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1} marginLeft=${1} width="50%" overflowY="hidden">
          <${Text} bold color="cyan">${currentPlugin?.plugin?.displayName || currentPlugin?.name || 'Info'}</Text>
          ${description ? html`<${Text} wrap="wrap">${description}</Text>` : null}
          ${truncatedDesc ? html`<${Box} marginTop=${1}><${Text} wrap="wrap" dimColor>${truncatedDesc}</Text></Box>` : null}
        </Box>
      </Box>

      <${Box} marginTop=${1}>
        <${Text} dimColor>↑↓: navigate │ Enter: configure sources │ q: quit</Text>
      </Box>
    </Box>
  `;
}

// ============================================================================
// Export
// ============================================================================

export async function runPluginsConfigure(plugins) {
  let pendingEditorRequest = null;

  while (true) {
    const handleEditorRequest = (request) => {
      pendingEditorRequest = request;
    };

    const { waitUntilExit } = render(html`<${PluginsConfigApp} plugins=${plugins} onEditorRequest=${handleEditorRequest} />`);
    await waitUntilExit();

    // Handle any pending editor request
    if (pendingEditorRequest) {
      const { pluginName, sourceName, fieldKey, currentValue } = pendingEditorRequest;
      pendingEditorRequest = null;

      // Open editor
      const newValue = editInEditor(currentValue || '', `${pluginName}-${sourceName}-${fieldKey}.txt`);

      // Save if editor returned a value (not cancelled)
      if (newValue !== null) {
        updateSourceField(pluginName, sourceName, fieldKey, newValue);
      }

      // Loop continues - will re-render the UI
    } else {
      // No action or quit - exit the loop
      break;
    }
  }

  console.log('\n✓ Plugin configuration complete.\n');
}

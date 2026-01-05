/**
 * Deployments configuration UI
 *
 * Interactive TUI for managing server deployments.
 * Follows the same pattern as plugins-configure-ui.js
 */

import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { TextInput, Select } from '@inkjs/ui';
import htm from 'htm';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { listProviders } from './deploy/providers/index.js';
import { getIpEnvVarName } from './deploy/config.js';

const html = htm.bind(React.createElement);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const CONFIG_PATH = path.join(projectRoot, 'config.toml');

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
  // Preserve multiline strings
  let tomlOutput = stringifyToml(config);

  tomlOutput = tomlOutput.replace(
    /^(ai_instructions\s*=\s*)"((?:[^"\\]|\\.)*)"/gm,
    (match, prefix, content) => {
      if (!content.includes('\\n')) return match;
      const unescaped = content
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trimEnd();
      return `${prefix}"""\n${unescaped}\n"""`;
    }
  );

  const header = `# Configuration for Today system
# Edit this file when your situation changes (e.g., when traveling)

`;

  fs.writeFileSync(CONFIG_PATH, header + tomlOutput);
}

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

function setEnvVar(key, value) {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '# Environment variables for Today\n\n');
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

// ============================================================================
// Get deployments from config
// ============================================================================

function getDeploymentsFromConfig() {
  const config = readConfig();
  const deploymentsConfig = config.deployments || {};
  const deployments = [];

  for (const [provider, providerDeployments] of Object.entries(deploymentsConfig)) {
    for (const [name, settings] of Object.entries(providerDeployments)) {
      const envVar = getIpEnvVarName(provider, name);
      const ip = getEnvVar(envVar);

      deployments.push({
        provider,
        name,
        envVar,
        ip,
        ...settings
      });
    }
  }

  return deployments;
}

// ============================================================================
// Main deployments config component
// ============================================================================

function DeploymentsConfigApp({ onExit }) {
  const { exit } = useApp();
  const [deployments, setDeployments] = useState(() => getDeploymentsFromConfig());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState('list'); // 'list', 'edit', 'add', 'add-provider', 'add-name'
  const [editField, setEditField] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [newDeployment, setNewDeployment] = useState({});

  const selected = deployments[selectedIndex];

  // Handle keyboard in list mode
  useInput((input, key) => {
    if (mode !== 'list') return;

    if (input === 'q' || key.escape) {
      if (onExit) onExit();
      exit();
      return;
    }

    if (key.downArrow || input === 'j') {
      setSelectedIndex(i => Math.min(i + 1, deployments.length));
    } else if (key.upArrow || input === 'k') {
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (key.return) {
      if (selectedIndex === deployments.length) {
        // "Add new deployment" option
        setMode('add-provider');
        setNewDeployment({});
      } else if (selected) {
        setMode('edit');
        setEditField('menu');
      }
    }
  });

  // Edit mode keyboard
  useInput((input, key) => {
    if (mode !== 'edit') return;

    if (key.escape) {
      setMode('list');
      setEditField(null);
      return;
    }

    if (editField === 'menu') {
      if (key.downArrow || input === 'j') {
        // Navigate menu
      } else if (key.upArrow || input === 'k') {
        // Navigate menu
      }
    }
  });

  // Refresh deployments from config
  const refreshDeployments = () => {
    setDeployments(getDeploymentsFromConfig());
  };

  // Save a deployment setting
  const saveDeploymentSetting = (provider, name, key, value) => {
    const config = readConfig();
    if (!config.deployments) config.deployments = {};
    if (!config.deployments[provider]) config.deployments[provider] = {};
    if (!config.deployments[provider][name]) config.deployments[provider][name] = {};

    if (value === '' || value === null) {
      delete config.deployments[provider][name][key];
    } else {
      config.deployments[provider][name][key] = value;
    }

    writeConfig(config);
    refreshDeployments();
  };

  // Create a new deployment
  const createDeployment = (provider, name) => {
    const config = readConfig();
    if (!config.deployments) config.deployments = {};
    if (!config.deployments[provider]) config.deployments[provider] = {};

    config.deployments[provider][name] = {
      enabled: true,
      deploy_path: '/opt/today'
    };

    writeConfig(config);
    refreshDeployments();
    setSelectedIndex(deployments.length); // Select the new one
    setMode('edit');
    setEditField('menu');
  };

  // Delete a deployment
  const deleteDeployment = (provider, name) => {
    const config = readConfig();
    if (config.deployments?.[provider]?.[name]) {
      delete config.deployments[provider][name];
      if (Object.keys(config.deployments[provider]).length === 0) {
        delete config.deployments[provider];
      }
    }
    writeConfig(config);
    refreshDeployments();
    setSelectedIndex(Math.max(0, selectedIndex - 1));
    setMode('list');
  };

  // Render deployment list
  const deploymentsList = deployments.map((d, i) => {
    const isSelected = i === selectedIndex;
    const statusIcon = d.enabled !== false ? (d.ip ? '✓' : '⚠') : '○';
    const statusColor = d.enabled !== false ? (d.ip ? 'green' : 'yellow') : 'gray';

    return html`
      <${Box} key=${`${d.provider}-${d.name}`}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}>
          ${isSelected ? '▸ ' : '  '}
        </${Text}>
        <${Text} color=${statusColor}>${statusIcon}</${Text}>
        <${Text} color=${isSelected ? 'cyan' : 'white'}> ${d.provider}/${d.name}</${Text}>
        ${d.domain ? html`<${Text} dimColor> (${d.domain})</${Text}>` : null}
      </${Box}>
    `;
  });

  // Add new deployment option
  const addOption = html`
    <${Box}>
      <${Text} color=${selectedIndex === deployments.length ? 'cyan' : 'white'}>
        ${selectedIndex === deployments.length ? '▸ ' : '  '}+ Add deployment
      </${Text}>
    </${Box}>
  `;

  // Provider selection for new deployment
  if (mode === 'add-provider') {
    const providers = listProviders();
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} bold>Add Deployment - Select Provider</${Text}>
        <${Box} marginTop=${1}>
          <${Select}
            options=${providers.map(p => ({ value: p.name, label: `${p.label} - ${p.description}` }))}
            onChange=${(value) => {
              setNewDeployment({ provider: value });
              setMode('add-name');
            }}
          />
        </${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>Esc: cancel</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  // Name input for new deployment
  if (mode === 'add-name') {
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} bold>Add Deployment - Enter Name</${Text}>
        <${Text} dimColor>Provider: ${newDeployment.provider}</${Text}>
        <${Box} marginTop=${1}>
          <${Text}>Name: </${Text}>
          <${TextInput}
            placeholder="production, staging, backup..."
            onSubmit=${(value) => {
              if (value && value.trim()) {
                createDeployment(newDeployment.provider, value.trim());
              }
              setMode('list');
            }}
          />
        </${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>Enter: create │ Esc: cancel</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  // Edit deployment view
  if (mode === 'edit' && selected) {
    const fields = [
      { key: 'enabled', label: 'Enabled', value: selected.enabled !== false ? 'Yes' : 'No', type: 'toggle' },
      { key: 'ip', label: 'Server IP', value: selected.ip || '(not set)', type: 'encrypted', envVar: selected.envVar },
      { key: 'domain', label: 'Domain', value: selected.domain || '(not set)', type: 'text' },
      { key: 'deploy_path', label: 'Deploy Path', value: selected.deploy_path || '/opt/today', type: 'text' },
      { key: 'remote_vault_path', label: 'Remote Vault Path', value: selected.remote_vault_path || 'vault', type: 'text' },
      { key: 'ssh_user', label: 'SSH User', value: selected.ssh_user || 'root', type: 'text' },
      { key: 'ssh_port', label: 'SSH Port', value: String(selected.ssh_port || 22), type: 'text' },
    ];

    if (editField && editField !== 'menu') {
      const field = fields.find(f => f.key === editField);
      return html`
        <${Box} flexDirection="column" padding=${1}>
          <${Text} bold>Edit: ${selected.provider}/${selected.name}</${Text}>
          <${Text}>Field: ${field?.label}</${Text}>
          <${Box} marginTop=${1}>
            <${TextInput}
              defaultValue=${field?.type === 'encrypted' ? '' : (field?.value === '(not set)' ? '' : field?.value)}
              placeholder=${field?.type === 'encrypted' ? 'Enter value (will be encrypted)...' : 'Enter value...'}
              onSubmit=${(value) => {
                if (field?.type === 'encrypted' && field?.envVar) {
                  if (value) setEnvVar(field.envVar, value);
                } else {
                  saveDeploymentSetting(selected.provider, selected.name, editField, value);
                }
                refreshDeployments();
                setEditField('menu');
              }}
            />
          </${Box}>
          <${Box} marginTop=${1}>
            <${Text} dimColor>Enter: save │ Esc: cancel</${Text}>
          </${Box}>
        </${Box}>
      `;
    }

    // Edit menu
    return html`
      <${Box} flexDirection="column" padding=${1}>
        <${Text} bold>Edit: ${selected.provider}/${selected.name}</${Text}>
        <${Box} flexDirection="column" marginTop=${1}>
          <${Select}
            options=${[
              ...fields.map(f => ({
                value: f.key,
                label: `${f.label}: ${f.value}${f.type === 'encrypted' ? ' [encrypted]' : ''}`
              })),
              { value: '__delete__', label: '🗑️  Delete this deployment' },
              { value: '__back__', label: '← Back to list' }
            ]}
            onChange=${(value) => {
              if (value === '__back__') {
                setMode('list');
              } else if (value === '__delete__') {
                deleteDeployment(selected.provider, selected.name);
              } else if (value === 'enabled') {
                // Toggle enabled
                saveDeploymentSetting(selected.provider, selected.name, 'enabled', selected.enabled === false);
              } else {
                setEditField(value);
                const field = fields.find(f => f.key === value);
                setEditValue(field?.value === '(not set)' ? '' : field?.value || '');
              }
            }}
          />
        </${Box}>
      </${Box}>
    `;
  }

  // Main list view
  return html`
    <${Box} flexDirection="column" padding=${1}>
      <${Box} marginBottom=${1}>
        <${Text} bold>Server Deployments</${Text}>
      </${Box}>

      ${deployments.length === 0 ? html`
        <${Box} marginBottom=${1}>
          <${Text} dimColor>No deployments configured yet.</${Text}>
        </${Box}>
      ` : null}

      <${Box} flexDirection="column" borderStyle="single" borderColor="gray" paddingX=${1}>
        ${deploymentsList}
        ${addOption}
      </${Box}>

      <${Box} marginTop=${1}>
        <${Text} dimColor>↑↓: navigate │ Enter: edit │ q: back</${Text}>
      </${Box}>
    </${Box}>
  `;
}

export async function runDeploymentsConfigure() {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(html`<${DeploymentsConfigApp} onExit=${resolve} />`);
    waitUntilExit().then(resolve);
  });
}

export default runDeploymentsConfigure;

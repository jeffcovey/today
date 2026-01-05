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
// Predefined jobs that can be toggled on/off
// ============================================================================

const PREDEFINED_JOBS = [
  {
    key: 'plugin-sync',
    label: 'Plugin Sync',
    description: 'Sync all plugins every 10 minutes',
    schedule: '*/10 * * * *',
    command: 'bin/plugins sync'
  }
];

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

function DeploymentsConfigApp({ onExit, initialEdit, addNew }) {
  const { exit } = useApp();
  const [deployments, setDeployments] = useState(() => getDeploymentsFromConfig());

  // Determine initial state based on props
  const getInitialState = () => {
    if (addNew) {
      return { index: 0, mode: 'add-provider', editField: 0 };
    }
    if (initialEdit) {
      const idx = deployments.findIndex(
        d => d.provider === initialEdit.provider && d.name === initialEdit.name
      );
      if (idx >= 0) {
        return { index: idx, mode: 'edit', editField: 0 };
      }
    }
    return { index: 0, mode: 'list', editField: 0 };
  };

  const initial = getInitialState();
  const [selectedIndex, setSelectedIndex] = useState(initial.index);
  const [mode, setMode] = useState(initial.mode); // 'list', 'edit', 'add', 'add-provider', 'add-name', 'services', 'jobs', 'add-job', 'edit-job', 'confirm-delete', 'confirm-delete-job'
  const [editField, setEditField] = useState(initial.editField);
  const [editValue, setEditValue] = useState(null);
  const [newDeployment, setNewDeployment] = useState({});
  const [newJobFieldIndex, setNewJobFieldIndex] = useState(0);
  const [serviceIndex, setServiceIndex] = useState(0);
  const [jobIndex, setJobIndex] = useState(0);
  const [editingJob, setEditingJob] = useState(null); // { name, schedule, command }
  const [jobFieldIndex, setJobFieldIndex] = useState(0);

  const selected = deployments[selectedIndex];

  // Track if we came from inline edit (should exit back to main config, not show list)
  const cameFromInline = initialEdit || addNew;

  // Consolidated keyboard handler for all modes (hooks must be called unconditionally)
  useInput((input, key) => {
    // List mode
    if (mode === 'list') {
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
          setMode('add-provider');
          setNewDeployment({});
        } else if (selected) {
          setMode('edit');
          setEditField(0);
        }
      }
      return;
    }

    // Edit mode
    if (mode === 'edit') {
      if (editValue !== null && typeof editValue === 'string') {
        if (key.escape) setEditValue(null);
        return;
      }

      const fields = [
        { key: 'enabled', type: 'boolean' },
        { key: 'ip', type: 'encrypted', envVar: selected?.envVar },
        { key: 'domain', type: 'text' },
        { key: 'deploy_path', type: 'text' },
        { key: 'remote_vault_path', type: 'text' },
        { key: 'ssh_user', type: 'text' },
        { key: 'ssh_port', type: 'text' },
        { key: '__services__', type: 'submenu' },
        { key: '__jobs__', type: 'submenu' },
        { key: '__delete__', type: 'action' },
      ];
      const fieldIdx = typeof editField === 'number' ? editField : 0;

      if (key.escape || input === 'q') {
        if (cameFromInline) {
          if (onExit) onExit();
          exit();
        } else {
          setMode('list');
          setEditField(0);
        }
        return;
      }
      if (key.downArrow || input === 'j') {
        setEditField(Math.min(fieldIdx + 1, fields.length - 1));
      } else if (key.upArrow || input === 'k') {
        setEditField(Math.max(fieldIdx - 1, 0));
      } else if (key.return) {
        const field = fields[fieldIdx];
        if (field.type === 'boolean') {
          saveDeploymentSetting(selected.provider, selected.name, 'enabled', selected.enabled === false);
          refreshDeployments();
        } else if (field.type === 'submenu') {
          if (field.key === '__services__') setMode('services');
          else if (field.key === '__jobs__') setMode('jobs');
        } else if (field.type === 'action' && field.key === '__delete__') {
          setMode('confirm-delete');
        } else if (field.type === 'encrypted') {
          setEditValue('');
        } else {
          setEditValue(String(selected[field.key] || ''));
        }
      }
      return;
    }

    // Services mode
    if (mode === 'services') {
      const serviceKeys = ['scheduler', 'vault-watcher', 'inbox-api', 'vault-web', '__back__'];
      if (key.escape || input === 'q') {
        setMode('edit');
        setServiceIndex(0);
        return;
      }
      if (key.downArrow || input === 'j') {
        setServiceIndex(i => Math.min(i + 1, serviceKeys.length - 1));
      } else if (key.upArrow || input === 'k') {
        setServiceIndex(i => Math.max(i - 1, 0));
      } else if (key.return) {
        const serviceKey = serviceKeys[serviceIndex];
        if (serviceKey === '__back__') {
          setMode('edit');
          setServiceIndex(0);
        } else {
          const config = readConfig();
          if (config.deployments?.[selected.provider]?.[selected.name]) {
            if (!config.deployments[selected.provider][selected.name].services) {
              config.deployments[selected.provider][selected.name].services = {};
            }
            const current = config.deployments[selected.provider][selected.name].services[serviceKey] === true;
            config.deployments[selected.provider][selected.name].services[serviceKey] = !current;
            writeConfig(config);
            refreshDeployments();
          }
        }
      }
      return;
    }

    // Jobs mode - predefined jobs (toggle) + custom jobs (edit)
    if (mode === 'jobs') {
      const jobs = selected?.jobs || {};
      // Filter out predefined jobs from custom jobs
      const predefinedKeys = PREDEFINED_JOBS.map(j => j.key);
      const customJobEntries = Object.entries(jobs).filter(([name]) => !predefinedKeys.includes(name));
      // Total: predefined jobs + custom jobs + add + back
      const totalItems = PREDEFINED_JOBS.length + customJobEntries.length + 2;

      if (key.escape || input === 'q') {
        setMode('edit');
        setJobIndex(0);
        return;
      }
      if (key.downArrow || input === 'j') {
        setJobIndex(i => Math.min(i + 1, totalItems - 1));
      } else if (key.upArrow || input === 'k') {
        setJobIndex(i => Math.max(i - 1, 0));
      } else if (key.return) {
        if (jobIndex < PREDEFINED_JOBS.length) {
          // Toggle predefined job
          const predefinedJob = PREDEFINED_JOBS[jobIndex];
          const config = readConfig();
          if (config.deployments?.[selected.provider]?.[selected.name]) {
            if (!config.deployments[selected.provider][selected.name].jobs) {
              config.deployments[selected.provider][selected.name].jobs = {};
            }
            const isEnabled = config.deployments[selected.provider][selected.name].jobs[predefinedJob.key];
            if (isEnabled) {
              delete config.deployments[selected.provider][selected.name].jobs[predefinedJob.key];
            } else {
              config.deployments[selected.provider][selected.name].jobs[predefinedJob.key] = {
                schedule: predefinedJob.schedule,
                command: predefinedJob.command,
                description: predefinedJob.description
              };
            }
            writeConfig(config);
            refreshDeployments();
          }
        } else if (jobIndex < PREDEFINED_JOBS.length + customJobEntries.length) {
          // Open custom job for editing
          const customIndex = jobIndex - PREDEFINED_JOBS.length;
          const [jobName, job] = customJobEntries[customIndex];
          setEditingJob({ name: jobName, schedule: job.schedule, command: job.command, originalName: jobName });
          setJobFieldIndex(0);
          setMode('edit-job');
        } else if (jobIndex === PREDEFINED_JOBS.length + customJobEntries.length) {
          // Add custom job
          setMode('add-job');
          setNewJobFieldIndex(0);
          setNewDeployment({ jobName: '', schedule: '*/10 * * * *', command: '' });
        } else {
          // Back
          setMode('edit');
          setJobIndex(0);
        }
      }
      return;
    }

    // Edit job mode
    if (mode === 'edit-job') {
      if (editValue !== null && typeof editValue === 'string') {
        if (key.escape) setEditValue(null);
        return;
      }

      const jobFields = [
        { key: 'schedule', label: 'Schedule', type: 'text' },
        { key: 'command', label: 'Command', type: 'text' },
        { key: '__delete__', label: '🗑️  Delete this job', type: 'action' },
        { key: '__back__', label: '← Back', type: 'action' },
      ];

      if (key.escape || input === 'q') {
        setMode('jobs');
        setJobFieldIndex(0);
        setEditingJob(null);
        return;
      }
      if (key.downArrow || input === 'j') {
        setJobFieldIndex(i => Math.min(i + 1, jobFields.length - 1));
      } else if (key.upArrow || input === 'k') {
        setJobFieldIndex(i => Math.max(i - 1, 0));
      } else if (key.return) {
        const field = jobFields[jobFieldIndex];
        if (field.key === '__back__') {
          setMode('jobs');
          setJobFieldIndex(0);
          setEditingJob(null);
        } else if (field.key === '__delete__') {
          // Show delete confirmation
          setMode('confirm-delete-job');
        } else {
          // Get fresh value from editingJob for the specific field
          const currentJob = editingJob;
          const fieldValue = currentJob ? currentJob[field.key] : '';
          setEditValue(fieldValue || '');
        }
      }
      return;
    }

    // Add job mode - consistent with edit-job
    if (mode === 'add-job') {
      if (editValue !== null && typeof editValue === 'string') {
        if (key.escape) setEditValue(null);
        return;
      }

      const newJobFields = [
        { key: 'jobName', label: 'Name', type: 'text' },
        { key: 'schedule', label: 'Schedule', type: 'text' },
        { key: 'command', label: 'Command', type: 'text' },
        { key: '__save__', label: '✓ Save job', type: 'action' },
        { key: '__cancel__', label: '← Cancel', type: 'action' },
      ];

      if (key.escape || input === 'q') {
        setMode('jobs');
        setNewJobFieldIndex(0);
        return;
      }
      if (key.downArrow || input === 'j') {
        setNewJobFieldIndex(i => Math.min(i + 1, newJobFields.length - 1));
      } else if (key.upArrow || input === 'k') {
        setNewJobFieldIndex(i => Math.max(i - 1, 0));
      } else if (key.return) {
        const field = newJobFields[newJobFieldIndex];
        if (field.key === '__cancel__') {
          setMode('jobs');
          setNewJobFieldIndex(0);
        } else if (field.key === '__save__') {
          // Validate and save
          if (newDeployment.jobName && newDeployment.command) {
            const config = readConfig();
            if (config.deployments?.[selected.provider]?.[selected.name]) {
              if (!config.deployments[selected.provider][selected.name].jobs) {
                config.deployments[selected.provider][selected.name].jobs = {};
              }
              config.deployments[selected.provider][selected.name].jobs[newDeployment.jobName] = {
                schedule: newDeployment.schedule || '*/10 * * * *',
                command: newDeployment.command,
                description: newDeployment.jobName
              };
              writeConfig(config);
              refreshDeployments();
            }
            setMode('jobs');
            setNewJobFieldIndex(0);
          }
        } else {
          setEditValue(newDeployment[field.key] || '');
        }
      }
      return;
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

  // Delete deployment confirmation view
  if (mode === 'confirm-delete' && selected) {
    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="red" paddingX=${1}>
        <${Text} bold color="red">Delete Deployment</${Text}>
        <${Box} marginTop=${1}>
          <${Text}>Are you sure you want to delete </${Text}>
          <${Text} bold>${selected.provider}/${selected.name}</${Text}>
          <${Text}>?</${Text}>
        </${Box}>
        <${Box} marginTop=${1}>
          <${Select}
            options=${[
              { value: 'no', label: 'No, keep it' },
              { value: 'yes', label: 'Yes, delete it' },
            ]}
            onChange=${(value) => {
              if (value === 'yes') {
                deleteDeployment(selected.provider, selected.name);
                if (cameFromInline) {
                  if (onExit) onExit();
                  exit();
                } else {
                  setMode('list');
                }
              } else {
                setMode('edit');
              }
            }}
          />
        </${Box}>
      </${Box}>
    `;
  }

  // Delete job confirmation view
  if (mode === 'confirm-delete-job' && selected && editingJob) {
    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="red" paddingX=${1}>
        <${Text} bold color="red">Delete Job</${Text}>
        <${Box} marginTop=${1}>
          <${Text}>Are you sure you want to delete job </${Text}>
          <${Text} bold>${editingJob.name}</${Text}>
          <${Text}>?</${Text}>
        </${Box}>
        <${Box} marginTop=${1}>
          <${Select}
            options=${[
              { value: 'no', label: 'No, keep it' },
              { value: 'yes', label: 'Yes, delete it' },
            ]}
            onChange=${(value) => {
              if (value === 'yes') {
                // Delete the job
                const config = readConfig();
                if (config.deployments?.[selected.provider]?.[selected.name]?.jobs?.[editingJob.originalName]) {
                  delete config.deployments[selected.provider][selected.name].jobs[editingJob.originalName];
                  if (Object.keys(config.deployments[selected.provider][selected.name].jobs).length === 0) {
                    delete config.deployments[selected.provider][selected.name].jobs;
                  }
                  writeConfig(config);
                  refreshDeployments();
                  setJobIndex(i => Math.max(0, i - 1));
                }
              }
              setMode('jobs');
              setJobFieldIndex(0);
              setEditingJob(null);
            }}
          />
        </${Box}>
      </${Box}>
    `;
  }

  // Edit deployment view - matches plugins pattern with field list navigation
  if (mode === 'edit' && selected) {
    // Get current services config
    const services = selected.services || {};
    const servicesList = [
      { key: 'scheduler', label: 'Scheduler', desc: 'Run scheduled jobs' },
      { key: 'vault-watcher', label: 'Vault Watcher', desc: 'Watch vault changes' },
      { key: 'inbox-api', label: 'Inbox API', desc: 'Receive uploads from mobile' },
      { key: 'vault-web', label: 'Vault Web', desc: 'Serve vault as static site' },
    ];

    // Get current jobs
    const jobs = selected.jobs || {};
    const jobCount = Object.keys(jobs).length;

    const enabledServiceNames = servicesList.filter(s => services[s.key]).map(s => s.label).join(', ') || 'None';

    const fields = [
      { key: 'enabled', label: 'Enabled', value: selected.enabled !== false, type: 'boolean' },
      { key: 'ip', label: 'Server IP', value: selected.ip ? '••••••••' : '(not set)', type: 'encrypted', envVar: selected.envVar },
      { key: 'domain', label: 'Domain', value: selected.domain || '(not set)', type: 'text' },
      { key: 'deploy_path', label: 'Deploy Path', value: selected.deploy_path || '/opt/today', type: 'text' },
      { key: 'remote_vault_path', label: 'Vault Path', value: selected.remote_vault_path || 'vault', type: 'text' },
      { key: 'ssh_user', label: 'SSH User', value: selected.ssh_user || 'root', type: 'text' },
      { key: 'ssh_port', label: 'SSH Port', value: String(selected.ssh_port || 22), type: 'text' },
      { key: '__services__', label: 'Services', value: enabledServiceNames, type: 'submenu' },
      { key: '__jobs__', label: 'Jobs', value: `${jobCount} configured`, type: 'submenu' },
      { key: '__delete__', label: '🗑️  Delete this deployment', value: '', type: 'action' },
    ];

    const currentField = fields[editField] || fields[0];
    const fieldIdx = typeof editField === 'number' ? editField : 0;

    // Render field rows like plugins does
    const fieldRows = fields.map((f, i) => {
      const isSelected = i === fieldIdx;

      // Action fields (like delete) don't show a value
      if (f.type === 'action') {
        return html`
          <${Box} key=${'field-' + f.key}>
            <${Text} color=${isSelected ? 'red' : 'gray'}>${isSelected ? '▸ ' : '  '}${f.label}</${Text}>
          </${Box}>
        `;
      }

      let displayValue;
      if (f.type === 'boolean') {
        displayValue = f.value ? 'Yes' : 'No';
      } else {
        displayValue = f.value || '(not set)';
      }
      const editHint = f.type === 'encrypted' ? ' [encrypted]' : (f.type === 'submenu' ? ' →' : '');
      return html`
        <${Box} key=${'field-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}${f.label}: </${Text}>
          <${Text} color="green">${displayValue}</${Text}>
          ${isSelected && editHint ? html`<${Text} dimColor>${editHint}</${Text}>` : null}
        </${Box}>
      `;
    });

    // Show text input when editing a field
    if (editValue !== null && typeof editValue === 'string') {
      const field = fields[fieldIdx];
      return html`
        <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
          <${Text} bold color="cyan">Edit: ${selected.provider}/${selected.name}</${Text}>
          <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
          <${Box} marginTop=${1} borderStyle="single" borderColor="yellow" paddingX=${1} flexDirection="column">
            <${Text} color="yellow">${field?.label}</${Text}>
            <${TextInput}
              defaultValue=${editValue}
              placeholder="Enter value..."
              onSubmit=${(value) => {
                if (field?.type === 'encrypted' && field?.envVar) {
                  if (value) setEnvVar(field.envVar, value);
                } else {
                  saveDeploymentSetting(selected.provider, selected.name, field.key, value);
                }
                refreshDeployments();
                setEditValue(null);
              }}
            />
          </${Box}>
        </${Box}>
      `;
    }

    // Main edit view with field navigation
    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
        <${Text} bold color="cyan">Edit: ${selected.provider}/${selected.name}</${Text}>
        <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: edit │ Esc: ${cameFromInline ? 'done' : 'back'}</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  if (mode === 'services' && selected) {
    const services = selected.services || {};
    const servicesList = [
      { key: 'scheduler', label: 'Scheduler', desc: 'Run scheduled jobs' },
      { key: 'vault-watcher', label: 'Vault Watcher', desc: 'Watch vault changes' },
      { key: 'inbox-api', label: 'Inbox API', desc: 'Receive uploads from mobile' },
      { key: 'vault-web', label: 'Vault Web', desc: 'Serve vault as static site' },
    ];

    const serviceRows = servicesList.map((s, i) => {
      const isSelected = i === serviceIndex;
      const isEnabled = services[s.key] === true;
      return html`
        <${Box} key=${'service-' + s.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}</${Text}>
          <${Text} color=${isEnabled ? 'green' : 'gray'}>${isEnabled ? '✓' : '○'}</${Text}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}> ${s.label}</${Text}>
          <${Text} dimColor> - ${s.desc}</${Text}>
        </${Box}>
      `;
    });

    const backSelected = serviceIndex === servicesList.length;

    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
        <${Text} bold color="cyan">Services: ${selected.provider}/${selected.name}</${Text}>
        <${Text} dimColor>Press Enter to toggle, Esc to go back</${Text}>
        <${Box} marginTop=${1} flexDirection="column">
          ${serviceRows}
          <${Box}>
            <${Text} color=${backSelected ? 'cyan' : 'white'}>${backSelected ? '▸ ' : '  '}← Back</${Text}>
          </${Box}>
        </${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: toggle │ Esc: back</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  if (mode === 'jobs' && selected) {
    const jobs = selected.jobs || {};
    const predefinedKeys = PREDEFINED_JOBS.map(j => j.key);
    const customJobEntries = Object.entries(jobs).filter(([name]) => !predefinedKeys.includes(name));

    // Predefined job rows (toggleable)
    const predefinedRows = PREDEFINED_JOBS.map((job, i) => {
      const isSelected = i === jobIndex;
      const isEnabled = !!jobs[job.key];
      return html`
        <${Box} key=${'predef-' + job.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}</${Text}>
          <${Text} color=${isEnabled ? 'green' : 'gray'}>${isEnabled ? '✓' : '○'}</${Text}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}> ${job.label}</${Text}>
          <${Text} dimColor> - ${job.description}</${Text}>
        </${Box}>
      `;
    });

    // Custom job rows (editable)
    const customRows = customJobEntries.map(([name, job], i) => {
      const isSelected = (i + PREDEFINED_JOBS.length) === jobIndex;
      return html`
        <${Box} key=${'custom-' + name}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}</${Text}>
          <${Text} color="green">✓</${Text}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}> ${name}</${Text}>
          <${Text} dimColor> - ${job.schedule} → ${job.command}</${Text}>
        </${Box}>
      `;
    });

    const addSelected = jobIndex === PREDEFINED_JOBS.length + customJobEntries.length;
    const backSelected = jobIndex === PREDEFINED_JOBS.length + customJobEntries.length + 1;

    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
        <${Text} bold color="cyan">Scheduled Jobs: ${selected.provider}/${selected.name}</${Text}>
        <${Text} dimColor>Jobs run when scheduler service is enabled. Maintenance jobs run automatically.</${Text}>
        <${Box} marginTop=${1} flexDirection="column">
          ${predefinedRows}
          ${customRows.length > 0 ? html`<${Box} marginTop=${1}><${Text} dimColor>Custom jobs:</${Text}></${Box}>` : null}
          ${customRows}
          <${Box} marginTop=${1}>
            <${Text} color=${addSelected ? 'cyan' : 'white'}>${addSelected ? '▸ ' : '  '}+ Add custom job</${Text}>
          </${Box}>
          <${Box}>
            <${Text} color=${backSelected ? 'cyan' : 'white'}>${backSelected ? '▸ ' : '  '}← Back</${Text}>
          </${Box}>
        </${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: toggle/edit │ Esc: back</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  // Edit job view
  if (mode === 'edit-job' && selected && editingJob) {
    const jobFields = [
      { key: 'schedule', label: 'Schedule', value: editingJob.schedule, type: 'text' },
      { key: 'command', label: 'Command', value: editingJob.command, type: 'text' },
      { key: '__delete__', label: '🗑️  Delete this job', type: 'action' },
      { key: '__back__', label: '← Back', type: 'action' },
    ];

    const fieldRows = jobFields.map((f, i) => {
      const isSelected = i === jobFieldIndex;

      if (f.type === 'action') {
        const color = f.key === '__delete__' ? (isSelected ? 'red' : 'gray') : (isSelected ? 'cyan' : 'white');
        return html`
          <${Box} key=${'jobfield-' + f.key}>
            <${Text} color=${color}>${isSelected ? '▸ ' : '  '}${f.label}</${Text}>
          </${Box}>
        `;
      }

      return html`
        <${Box} key=${'jobfield-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}${f.label}: </${Text}>
          <${Text} color="green">${f.value || '(not set)'}</${Text}>
        </${Box}>
      `;
    });

    // Show text input when editing a field
    if (editValue !== null && typeof editValue === 'string') {
      const field = jobFields[jobFieldIndex];
      return html`
        <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
          <${Text} bold color="cyan">Edit Job: ${editingJob.name}</${Text}>
          <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
          <${Box} marginTop=${1} borderStyle="single" borderColor="yellow" paddingX=${1} flexDirection="column">
            <${Text} color="yellow">${field?.label}</${Text}>
            <${TextInput}
              defaultValue=${editValue}
              placeholder=${field?.key === 'schedule' ? '*/10 * * * *' : 'bin/command'}
              onSubmit=${(value) => {
                if (value && value.trim()) {
                  // Update the editingJob state
                  setEditingJob(j => ({ ...j, [field.key]: value.trim() }));
                  // Save to config
                  const config = readConfig();
                  if (config.deployments?.[selected.provider]?.[selected.name]?.jobs?.[editingJob.originalName]) {
                    config.deployments[selected.provider][selected.name].jobs[editingJob.originalName][field.key] = value.trim();
                    writeConfig(config);
                    refreshDeployments();
                  }
                }
                setEditValue(null);
              }}
            />
          </${Box}>
        </${Box}>
      `;
    }

    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
        <${Text} bold color="cyan">Edit Job: ${editingJob.name}</${Text}>
        <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: edit │ Esc: back</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  // Add job view - consistent field list pattern
  if (mode === 'add-job' && selected) {
    const newJobFields = [
      { key: 'jobName', label: 'Name', value: newDeployment.jobName, type: 'text' },
      { key: 'schedule', label: 'Schedule', value: newDeployment.schedule, type: 'text' },
      { key: 'command', label: 'Command', value: newDeployment.command, type: 'text' },
      { key: '__save__', label: '✓ Save job', type: 'action' },
      { key: '__cancel__', label: '← Cancel', type: 'action' },
    ];

    const canSave = newDeployment.jobName && newDeployment.command;

    const fieldRows = newJobFields.map((f, i) => {
      const isSelected = i === newJobFieldIndex;

      if (f.type === 'action') {
        const color = f.key === '__save__'
          ? (isSelected ? (canSave ? 'green' : 'gray') : (canSave ? 'green' : 'gray'))
          : (isSelected ? 'cyan' : 'white');
        return html`
          <${Box} key=${'newjobfield-' + f.key}>
            <${Text} color=${color}>${isSelected ? '▸ ' : '  '}${f.label}</${Text}>
            ${f.key === '__save__' && !canSave ? html`<${Text} dimColor> (set name and command first)</${Text}>` : null}
          </${Box}>
        `;
      }

      return html`
        <${Box} key=${'newjobfield-' + f.key}>
          <${Text} color=${isSelected ? 'cyan' : 'white'}>${isSelected ? '▸ ' : '  '}${f.label}: </${Text}>
          <${Text} color="green">${f.value || '(not set)'}</${Text}>
        </${Box}>
      `;
    });

    // Show text input when editing a field
    if (editValue !== null && typeof editValue === 'string') {
      const field = newJobFields[newJobFieldIndex];
      const placeholder = field?.key === 'schedule' ? '*/10 * * * *' : (field?.key === 'jobName' ? 'plugin-sync, backup, etc.' : 'bin/plugins sync');
      return html`
        <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
          <${Text} bold color="cyan">Add Job</${Text}>
          <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
          <${Box} marginTop=${1} borderStyle="single" borderColor="yellow" paddingX=${1} flexDirection="column">
            <${Text} color="yellow">${field?.label}</${Text}>
            <${TextInput}
              defaultValue=${editValue}
              placeholder=${placeholder}
              onSubmit=${(value) => {
                if (value !== null) {
                  setNewDeployment(d => ({ ...d, [field.key]: value.trim() }));
                }
                setEditValue(null);
              }}
            />
          </${Box}>
        </${Box}>
      `;
    }

    return html`
      <${Box} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX=${1}>
        <${Text} bold color="cyan">Add Job</${Text}>
        <${Box} marginTop=${1} flexDirection="column">${fieldRows}</${Box}>
        <${Box} marginTop=${1}>
          <${Text} dimColor>↑↓: navigate │ Enter: edit │ Esc: cancel</${Text}>
        </${Box}>
      </${Box}>
    `;
  }

  // If we came from inline and somehow ended up in list mode, just exit
  if (cameFromInline && mode === 'list') {
    if (onExit) onExit();
    exit();
    return null;
  }

  // Main list view (only shown when NOT coming from inline)
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

export async function runDeploymentsConfigure(options = {}) {
  const { editDeployment, addNew } = options;

  // Clear terminal completely when opening for full-screen experience
  console.clear();

  return new Promise((resolve) => {
    const { waitUntilExit } = render(html`<${DeploymentsConfigApp}
      onExit=${resolve}
      initialEdit=${editDeployment}
      addNew=${addNew}
    />`);
    waitUntilExit().then(resolve);
  });
}

export default runDeploymentsConfigure;

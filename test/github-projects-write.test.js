import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const WRITE_SCRIPT = path.join(REPO_ROOT, 'plugins/github-projects/write.js');

function createGhMock(binDir) {
  const ghPath = path.join(binDir, 'gh');
  const script = `#!/usr/bin/env node
const fs = require('fs');

const scenario = process.env.GH_MOCK_SCENARIO;
const logPath = process.env.GH_MOCK_LOG;
const queryArg = process.argv.find(arg => arg.startsWith('query=')) || '';
const query = queryArg.slice(6);

if (logPath) {
  fs.appendFileSync(logPath, query + '\\n---\\n');
}

function output(payload) {
  process.stdout.write(JSON.stringify(payload));
}

if (query.includes('fields(first: 20)')) {
  const metadataNodes = scenario === 'existing'
    ? [{
        id: 'ITEM_META_1',
        content: {
          id: 'ISSUE_META_1',
          number: 434,
          title: '[META] AI-Agnostic Architecture Review Schedule'
        }
      }]
    : [];
  output({
    data: {
      user: {
        projectV2: {
          id: 'PROJECT_1',
          title: 'AI-Agnostic Architecture',
          fields: {
            nodes: [{ id: 'FIELD_REVIEW', name: 'Next Review Date', dataType: 'DATE' }]
          },
          items: {
            nodes: [
              { id: 'ITEM_1', content: { id: 'ISSUE_1', number: 1, title: 'Task issue' } },
              ...metadataNodes
            ]
          }
        }
      }
    }
  });
} else if (query.includes('items(first: 10)')) {
  output({
    data: {
      user: {
        projectV2: {
          items: {
            nodes: [{
              content: {
                repository: {
                  name: 'today',
                  owner: { login: 'jeffcovey' }
                }
              }
            }]
          }
        }
      }
    }
  });
} else if (query.includes('repository(owner:')) {
  output({ data: { repository: { id: 'REPO_1' } } });
} else if (query.includes('updateIssue(input:')) {
  output({
    data: {
      updateIssue: {
        issue: {
          id: 'ISSUE_META_1',
          number: 434,
          url: 'https://github.com/jeffcovey/today/issues/434'
        }
      }
    }
  });
} else if (query.includes('createIssue(input:')) {
  output({
    data: {
      createIssue: {
        issue: {
          id: 'ISSUE_META_NEW',
          number: 500,
          url: 'https://github.com/jeffcovey/today/issues/500'
        }
      }
    }
  });
} else if (query.includes('addProjectV2ItemById(input:')) {
  output({ data: { addProjectV2ItemById: { item: { id: 'ITEM_META_NEW' } } } });
} else if (query.includes('updateProjectV2ItemFieldValue(input:')) {
  output({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ANY_ITEM' } } } });
} else {
  output({ data: {} });
}
`;

  fs.writeFileSync(ghPath, script, { mode: 0o755 });
}

function runWrite({ scenario, reviewDate = '2026-09-30', frequency = 'weekly' }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-projects-write-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir);
  createGhMock(binDir);

  const logPath = path.join(tempDir, 'queries.log');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GH_MOCK_SCENARIO: scenario,
    GH_MOCK_LOG: logPath,
    PLUGIN_WRITE_ARGS: JSON.stringify({
      action: 'set-review-date',
      projectId: 'jeffcovey#1',
      reviewDate,
      frequency
    })
  };

  const stdout = execFileSync('node', [WRITE_SCRIPT], { env, encoding: 'utf8' });
  const result = JSON.parse(stdout);
  const queries = fs.readFileSync(logPath, 'utf8');

  fs.rmSync(tempDir, { recursive: true, force: true });
  return { result, queries };
}

describe('github-projects/write.js set-review-date metadata issue handling', () => {
  test('updates existing metadata issue and reuses existing project item', () => {
    const { result, queries } = runWrite({
      scenario: 'existing',
      reviewDate: '2026-10-02',
      frequency: 'monthly'
    });

    expect(result.success).toBe(true);
    expect(result.updated.metadataIssue.number).toBe(434);
    expect(result.updated.metadataIssue.itemId).toBe('ITEM_META_1');
    expect(queries).toContain('updateIssue(input:');
    expect(queries).not.toContain('createIssue(input:');
    expect(queries).not.toContain('addProjectV2ItemById(input:');
  });

  test('creates metadata issue and adds it to project on first run', () => {
    const { result, queries } = runWrite({
      scenario: 'missing',
      reviewDate: '2026-10-05',
      frequency: 'weekly'
    });

    expect(result.success).toBe(true);
    expect(result.updated.metadataIssue.number).toBe(500);
    expect(result.updated.metadataIssue.itemId).toBe('ITEM_META_NEW');
    expect(queries).toContain('createIssue(input:');
    expect(queries).toContain('addProjectV2ItemById(input:');
    expect(queries).not.toContain('updateIssue(input:');
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { installRoleTemplates } from '../src/plugin-loader.js';

describe('installRoleTemplates', () => {
  let tempDir;
  let src;
  let dest;

  const freshResult = () => ({ installed: [], skipped: [], errors: [] });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-templates-'));
    src = path.join(tempDir, 'skeleton-roles');
    dest = path.join(tempDir, 'vault', 'roles');

    fs.mkdirSync(path.join(src, '_template'), { recursive: true });
    fs.mkdirSync(path.join(src, 'chief-of-staff'), { recursive: true });
    fs.writeFileSync(path.join(src, 'REPORTING.md'), 'shared rules');
    fs.writeFileSync(path.join(src, '_template', 'SKILL.md'), 'template');
    fs.writeFileSync(path.join(src, 'chief-of-staff', 'SKILL.md'), 'chief');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('installs top-level shared files and role directory files', () => {
    const result = installRoleTemplates(src, dest, freshResult());

    expect(result.errors).toEqual([]);
    expect(result.installed.sort()).toEqual([
      'skeleton:roles/REPORTING.md',
      'skeleton:roles/_template/SKILL.md',
      'skeleton:roles/chief-of-staff/SKILL.md'
    ]);
    expect(fs.readFileSync(path.join(dest, 'REPORTING.md'), 'utf8')).toBe('shared rules');
    expect(fs.readFileSync(path.join(dest, 'chief-of-staff', 'SKILL.md'), 'utf8')).toBe('chief');
  });

  test('never overwrites files the user already has', () => {
    fs.mkdirSync(path.join(dest, 'chief-of-staff'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'REPORTING.md'), 'my edited rules');
    fs.writeFileSync(path.join(dest, 'chief-of-staff', 'SKILL.md'), 'my chief');

    const result = installRoleTemplates(src, dest, freshResult());

    expect(result.installed).toEqual(['skeleton:roles/_template/SKILL.md']);
    expect(result.skipped.sort()).toEqual([
      'skeleton:roles/REPORTING.md',
      'skeleton:roles/chief-of-staff/SKILL.md'
    ]);
    expect(fs.readFileSync(path.join(dest, 'REPORTING.md'), 'utf8')).toBe('my edited rules');
    expect(fs.readFileSync(path.join(dest, 'chief-of-staff', 'SKILL.md'), 'utf8')).toBe('my chief');
  });

  test('does nothing when the skeleton directory is absent', () => {
    const result = installRoleTemplates(path.join(tempDir, 'missing'), dest, freshResult());

    expect(result).toEqual(freshResult());
    expect(fs.existsSync(dest)).toBe(false);
  });
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(projectRoot, 'bin', 'email'), 'utf8');

describe('bin/email regressions', () => {
  test('uses exact source matching instead of substring matching', () => {
    expect(source).toContain('function addExactSourceCondition');
    expect(source.match(/addExactSourceCondition\(conditions, params, options\.source\);/g)).toHaveLength(3);
    expect(source).not.toContain("conditions.push('source LIKE ?')");
  });

  test('uses the encrypted-settings env var naming contract for IMAP passwords', () => {
    expect(source).toContain("import { getEncryptedEnvVarName } from '../src/encrypted-settings.js';");
    expect(source).toContain("return getEncryptedEnvVarName('imap-email', sourceName, 'password');");
    expect(source).toContain('const envKey = getImapPasswordEnvKey(source.sourceName);');
    expect(source).toContain('const envKey = getImapPasswordEnvKey(sourceName);');
  });

  test('search, download, and move always logout after connect', () => {
    expect(source.match(/let connected = false;/g)).toHaveLength(3);
    expect(source.match(/if \(connected\) \{\s*try \{ await client\.logout\(\); \} catch \{ \/\* ignore logout errors \*\/ \}\s*\}/g)).toHaveLength(3);
  });
});

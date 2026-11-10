import {
  INBOX, folderKeyword, isFilingKeyword, parseFolders, parseRules, serializeRules,
  lookupRule, learnFromFolders, planInbox, planJunk, findJunkMailbox, setRule, buildClassificationPrompt,
  parseClassification, resolveMailboxPath,
} from '../plugins/email-filing/filing.js';

const FOLDERS = ['Newsletters', 'Receipts'];

describe('folderKeyword', () => {
  test('is a stable, IMAP-safe keyword per folder', () => {
    const kw = folderKeyword('Receipts');
    expect(kw).toMatch(/^\$TodayIn_[0-9a-f]{10}$/);
    expect(folderKeyword('Receipts')).toBe(kw);
    expect(folderKeyword('Newsletters')).not.toBe(kw);
    expect(isFilingKeyword(kw)).toBe(true);
    expect(isFilingKeyword('\\Seen')).toBe(false);
  });

  test('treats inbox case-insensitively', () => {
    expect(folderKeyword('inbox')).toBe(folderKeyword(INBOX));
  });
});

describe('parseFolders', () => {
  test('keeps named folders and drops INBOX and blanks', () => {
    expect(parseFolders({ Receipts: 'Orders', INBOX: 'x', ' ': 'y' })).toEqual([
      { name: 'Receipts', description: 'Orders' },
    ]);
    expect(parseFolders(undefined)).toEqual([]);
    expect(parseFolders(['Receipts'])).toEqual([]);
  });
});

describe('rules file', () => {
  test('round-trips through serialize and parse', () => {
    const rules = {
      personal: {
        'news@example.com': { folder: 'Newsletters', source: 'learned' },
        'shop.example': { folder: 'Receipts', source: 'ai' },
      },
    };
    const text = serializeRules(rules);
    expect(text).toContain('# Email filing rules');
    expect(parseRules(text)).toEqual(rules);
  });

  test('accepts hand-written shorthand and normalizes addresses', () => {
    const rules = parseRules(`
[personal.senders]
"Friend@Example.org" = "INBOX"
"x@example.com" = { folder = "Receipts", source = "bogus" }
"y@example.com" = { source = "ai" }
`);
    expect(rules.personal).toEqual({
      'friend@example.org': { folder: 'INBOX', source: 'manual' },
      'x@example.com': { folder: 'Receipts', source: 'manual' },
    });
  });

  test('empty text means no rules', () => {
    expect(parseRules('')).toEqual({});
  });
});

describe('lookupRule', () => {
  const senders = {
    'boss@work.example': { folder: INBOX, source: 'learned' },
    'work.example': { folder: 'Newsletters', source: 'manual' },
    'gone@example.com': { folder: 'Deleted Folder', source: 'ai' },
  };

  test('prefers the address, then the domain and parent domains', () => {
    expect(lookupRule(senders, 'Boss@Work.Example', FOLDERS).folder).toBe(INBOX);
    expect(lookupRule(senders, 'list@work.example', FOLDERS).folder).toBe('Newsletters');
    expect(lookupRule(senders, 'a@mail.work.example', FOLDERS).folder).toBe('Newsletters');
    expect(lookupRule(senders, 'a@other.example', FOLDERS)).toBeNull();
  });

  test('ignores rules for folders no longer configured', () => {
    expect(lookupRule(senders, 'gone@example.com', FOLDERS)).toBeNull();
  });
});

describe('setRule', () => {
  test('a learned rule overrides; an AI rule only fills a gap', () => {
    const senders = {};
    expect(setRule(senders, 'a@x.com', 'Receipts', 'ai')).toBe(true);
    expect(setRule(senders, 'a@x.com', 'Newsletters', 'ai')).toBe(false);
    expect(setRule(senders, 'A@x.com', 'Newsletters', 'learned')).toBe(true);
    expect(senders['a@x.com']).toEqual({ folder: 'Newsletters', source: 'learned' });
    expect(setRule(senders, 'a@x.com', 'Newsletters', 'learned')).toBe(false);
  });
});

describe('learnFromFolders', () => {
  test('learns from untagged messages, newest move winning', () => {
    const learned = learnFromFolders([
      { folder: 'Receipts', address: 'a@x.com', date: '2026-01-02', flags: [] },
      { folder: 'Newsletters', address: 'A@x.com', date: '2026-01-01', flags: [] },
      { folder: 'Receipts', address: 'b@x.com', date: '2026-01-03', flags: [folderKeyword('Receipts')] },
    ]);
    expect(learned).toEqual([
      { address: 'a@x.com', folder: 'Newsletters' },
      { address: 'a@x.com', folder: 'Receipts' },
    ]);
  });

  test('a message filed elsewhere and moved here is learned', () => {
    expect(learnFromFolders([
      { folder: 'Receipts', address: 'a@x.com', date: '2026-01-01', flags: [folderKeyword('Newsletters')] },
    ])).toEqual([{ address: 'a@x.com', folder: 'Receipts' }]);
  });
});

describe('planInbox', () => {
  const senders = {
    'shop@x.com': { folder: 'Receipts', source: 'ai' },
    'friend@x.com': { folder: INBOX, source: 'learned' },
  };

  test('files by rule, keeps inbox rules, and collects unknowns', () => {
    const plan = planInbox([
      { uid: 1, address: 'shop@x.com', flags: [] },
      { uid: 2, address: 'friend@x.com', flags: [] },
      { uid: 3, address: 'new@x.com', flags: [] },
      { uid: 4, address: 'shop@x.com', flags: ['\\Deleted'] },
      { uid: 5, address: '', flags: [] },
    ], senders, FOLDERS);
    expect(plan.moves).toEqual([{ uid: 1, address: 'shop@x.com', folder: 'Receipts' }]);
    expect(plan.unknown.map(m => m.uid)).toEqual([3]);
    expect(plan.movedBack).toEqual([]);
  });

  test('a filed message back in the inbox was moved back by the user', () => {
    const kw = folderKeyword('Receipts');
    const plan = planInbox([{ uid: 7, address: 'Shop@x.com', flags: ['\\Seen', kw] }], senders, FOLDERS);
    expect(plan.movedBack).toEqual([{ uid: 7, address: 'shop@x.com', staleKeywords: [kw] }]);
    expect(plan.moves).toEqual([]);
  });

  test('without keyword support, filing keywords are not read as moves', () => {
    const kw = folderKeyword('Receipts');
    const plan = planInbox([{ uid: 7, address: 'shop@x.com', flags: [kw] }], senders, FOLDERS, { keywordsSupported: false });
    expect(plan.movedBack).toEqual([]);
    expect(plan.moves).toHaveLength(1);
  });
});

describe('AI classification', () => {
  const folders = [{ name: 'Newsletters', description: 'Bulk mail' }, { name: 'Receipts', description: 'Orders' }];

  test('the prompt names every folder and message', () => {
    const prompt = buildClassificationPrompt(folders, [
      { address: 'news@x.com', fromName: 'X News', subject: 'Weekly', listId: '<news.x.com>', listUnsubscribe: true },
    ]);
    expect(prompt).toContain('"Newsletters": Bulk mail');
    expect(prompt).toContain('"INBOX"');
    expect(prompt).toContain('X News <news@x.com>');
    expect(prompt).toContain('List-Id: <news.x.com>; has List-Unsubscribe');
  });

  test('parses a reply, mapping unknown folders to INBOX', () => {
    const reply = 'Sure:\n[{"n":1,"folder":"newsletters"},{"n":2,"folder":"Spam"},{"n":9,"folder":"Receipts"},{"n":3,"folder":"INBOX"}]';
    expect(parseClassification(reply, ['Newsletters', 'Receipts'], 3)).toEqual({ 0: 'Newsletters', 1: INBOX, 2: INBOX });
  });

  test('an unparseable reply decides nothing', () => {
    expect(parseClassification('no idea', ['Receipts'], 2)).toEqual({});
    expect(parseClassification('[oops', ['Receipts'], 2)).toEqual({});
  });
});

describe('resolveMailboxPath', () => {
  test('matches an existing mailbox with or without the namespace prefix', () => {
    const existing = ['INBOX', 'INBOX.Receipts', 'Archive'];
    const ns = { prefix: 'INBOX.', delimiter: '.' };
    expect(resolveMailboxPath('Receipts', existing, ns)).toEqual({ path: 'INBOX.Receipts', exists: true });
    expect(resolveMailboxPath('archive', existing, ns)).toEqual({ path: 'Archive', exists: true });
  });

  test('builds a new path with the prefix and delimiter', () => {
    expect(resolveMailboxPath('Mail/Receipts', [], { prefix: 'INBOX.', delimiter: '.' }))
      .toEqual({ path: 'INBOX.Mail.Receipts', exists: false });
    expect(resolveMailboxPath('Receipts', ['INBOX'], {})).toEqual({ path: 'Receipts', exists: false });
  });
});

describe('planJunk', () => {
  const senders = {
    'shop@x.com': { folder: 'Receipts', source: 'learned' },
    'friend@x.com': { folder: 'inbox', source: 'manual' },
    'ai@x.com': { folder: 'Newsletters', source: 'ai' },
  };

  test('rescues only senders with rules the user made', () => {
    const rescues = planJunk([
      { uid: 1, address: 'Shop@x.com', flags: ['$Junk'] },
      { uid: 2, address: 'friend@x.com', flags: [] },
      { uid: 3, address: 'ai@x.com', flags: [] },
      { uid: 4, address: 'spammer@y.com', flags: [] },
      { uid: 5, address: 'shop@x.com', flags: ['\\Deleted'] },
    ], senders, FOLDERS);
    expect(rescues).toEqual([
      { uid: 1, address: 'shop@x.com', folder: 'Receipts' },
      { uid: 2, address: 'friend@x.com', folder: INBOX },
    ]);
  });
});

describe('findJunkMailbox', () => {
  const boxes = [
    { path: 'INBOX' },
    { path: 'INBOX.Spam' },
    { path: 'Bulk', specialUse: '\\Junk' },
  ];

  test('prefers the \\Junk special-use mailbox', () => {
    expect(findJunkMailbox(boxes)).toBe('Bulk');
  });

  test('falls back to Junk or Spam, under the namespace prefix too', () => {
    expect(findJunkMailbox([{ path: 'INBOX' }, { path: 'INBOX.Spam' }], { prefix: 'INBOX.' })).toBe('INBOX.Spam');
    expect(findJunkMailbox([{ path: 'Junk' }])).toBe('Junk');
    expect(findJunkMailbox([{ path: 'INBOX' }])).toBeNull();
  });

  test('uses a configured path, with or without the prefix', () => {
    expect(findJunkMailbox(boxes, { configured: 'Spam', prefix: 'INBOX.' })).toBe('INBOX.Spam');
    expect(findJunkMailbox(boxes, { configured: 'Nope', prefix: 'INBOX.' })).toBeNull();
  });
});

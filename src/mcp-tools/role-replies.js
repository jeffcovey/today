/**
 * reply_to_role: the MCP version of the reply form under each role's block
 * in today's daily plan (POST ROLE_REPLY_ENDPOINT, plugins/roles/web-reply.js).
 *
 * Roles read a reply as the user's own word, so the tool's description tells
 * the client to pass only text the user wrote. The write itself is
 * saveRoleReply, the same function the web form uses: it appends
 * "-> role: text" just before the block's END marker, under the roles
 * plugin's lock, and only in today's plan.
 */

import fs from 'fs';
import path from 'path';
import { getAbsoluteVaultPath } from '../config.js';
import { getConfiguredTimezone } from '../date-utils.js';
import { jsonResult, errorResult } from '../mcp-safeguards.js';
import { saveRoleReply, ROLE_REPLY_ENDPOINT } from '../../plugins/roles/web-reply.js';
import { rolesPluginEnabled, MAX_REPLY_LENGTH } from '../../plugins/roles/block-writer.js';
import { todayPlanRelativePath, todayDateString } from '../../plugins/roles/plan-file.js';
import { ROLE_NAME_RE } from '../diary-role-blocks.js';

/** Roles with a block in this plan text, in order. */
export function rolesInPlan(text) {
  const roles = [];
  for (const m of String(text || '').matchAll(/<!-- ROLE:([a-z0-9-]+):START -->/g)) {
    if (text.includes(`<!-- ROLE:${m[1]}:END -->`) && !roles.includes(m[1])) roles.push(m[1]);
  }
  return roles;
}

async function replyToRole(args, ctx) {
  const now = ctx.now ? ctx.now() : new Date();
  const enabled = ctx.rolesEnabled || rolesPluginEnabled;
  if (!enabled()) return errorResult('The roles plugin is not enabled');

  const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : '';
  if (!ROLE_NAME_RE.test(role)) return errorResult(`"${args.role ?? ''}" is not a role name (lowercase letters, digits and hyphens)`);

  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) return errorResult('text is required: the reply the user wrote');
  if (text.trim().length > MAX_REPLY_LENGTH) {
    return errorResult(`The reply is ${text.trim().length} characters; the limit is ${MAX_REPLY_LENGTH}`);
  }

  const today = todayDateString(now);
  const date = typeof args.date === 'string' && args.date.trim() ? args.date.trim() : today;
  if (date !== today) {
    return errorResult(`Only today's plan (${today}) takes replies; roles read today's file, so a reply on ${date} would not reach them. Nothing was written.`);
  }

  const vaultPath = getAbsoluteVaultPath();
  const relativePath = todayPlanRelativePath(now);
  const file = path.join(vaultPath, relativePath);
  let planText;
  try {
    planText = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return errorResult(`There is no plan for ${today} yet (${relativePath}), so no role has reported today`);
    throw error;
  }
  const roles = rolesInPlan(planText);
  if (!roles.includes(role)) {
    return errorResult(roles.length
      ? `No ${role} block in today's plan. Roles that reported today: ${roles.join(', ')}. Nothing was written.`
      : `No role has reported in today's plan yet, so there is no ${role} block to reply under. Nothing was written.`);
  }

  const { status, body } = saveRoleReply(vaultPath, relativePath, role, text, { now, enabled });
  if (status !== 200) return errorResult(body.error || `Reply not saved (${status})`);

  return jsonResult({
    date: today,
    role,
    reply: body.reply,
    file: relativePath,
    user_timezone: getConfiguredTimezone(),
  }, `Saved your reply under the ${role} block in today's plan. The role reads it on its next run.`);
}

export const tools = [
  {
    name: 'reply_to_role',
    kind: 'write',
    pluginType: 'utility',
    description: 'Reply to a role agent under its block in today\'s daily plan, as the reply form on the web plan does ' +
      `(${ROLE_REPLY_ENDPOINT}). The reply is saved as "-> role: text" at the end of that role's block. ` +
      'Roles treat a reply as the user\'s own word and act on it. Pass ONLY words the user wrote themselves, verbatim: ' +
      'never text you composed, summarized, rephrased or suggested, even if the user agreed with it. ' +
      'If the user has not written the reply, ask them for it. Only today\'s plan takes replies, and only roles that reported today.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The plan\'s date, YYYY-MM-DD. Must be today (the default).' },
        role: { type: 'string', description: 'The role\'s name as in its block, e.g. "cpa"' },
        text: { type: 'string', description: 'The user\'s reply, exactly as they wrote it. Markdown is kept as typed.' },
      },
      required: ['role', 'text'],
    },
    handler: replyToRole,
  },
];

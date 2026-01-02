#!/usr/bin/env node

/**
 * stages context plugin
 *
 * Provides context about the user's day-based task grouping system:
 * - Front Stage: Outward-facing work (meetings, calls, emails, support)
 * - Back Stage: Maintenance work (bills, bug fixes, organizing)
 * - Off Stage: Personal time (nature, friends, reading, rest)
 *
 * The user assigns different days to different stages to batch similar
 * types of work together.
 */

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');

// Stage definitions from config
const stages = {
  front: {
    name: config.front_stage_name || 'Front Stage',
    description: config.front_stage_description || 'Outward-facing work: meetings, calls, emails, support, communications',
    tag: config.front_stage_tag || '#stage/front-stage',
  },
  back: {
    name: config.back_stage_name || 'Back Stage',
    description: config.back_stage_description || 'Maintenance work: bills, bug fixes, organizing, admin tasks',
    tag: config.back_stage_tag || '#stage/back-stage',
  },
  off: {
    name: config.off_stage_name || 'Off Stage',
    description: config.off_stage_description || 'Personal time: nature, friends, reading, hobbies, rest',
    tag: config.off_stage_tag || '#stage/off-stage',
  },
};

// Day-to-stage mapping from config
const dayMapping = {
  monday: config.monday || 'front',
  tuesday: config.tuesday || 'off',
  wednesday: config.wednesday || 'front',
  thursday: config.thursday || 'back',
  friday: config.friday || 'off',
  saturday: config.saturday || 'front',
  sunday: config.sunday || 'back',
};

/**
 * Get current day of week
 */
function getCurrentDay() {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[new Date().getDay()];
}

/**
 * Get stage for a given day
 */
function getStageForDay(day) {
  const stageKey = dayMapping[day.toLowerCase()];
  return stages[stageKey] || stages.front;
}

/**
 * Build weekly schedule overview
 */
function buildWeeklySchedule() {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const lines = [];

  for (const day of days) {
    const stage = getStageForDay(day);
    const dayName = day.charAt(0).toUpperCase() + day.slice(1);
    lines.push(`- **${dayName}**: ${stage.name}`);
  }

  return lines.join('\n');
}

// Main
const today = getCurrentDay();
const todayName = today.charAt(0).toUpperCase() + today.slice(1);
const currentStage = getStageForDay(today);

const context = `## Day Stages System

The user organizes their week into three "stages" to batch similar types of work:

### Stage Definitions

**${stages.front.name}** (${stages.front.tag})
${stages.front.description}

**${stages.back.name}** (${stages.back.tag})
${stages.back.description}

**${stages.off.name}** (${stages.off.tag})
${stages.off.description}

### Today's Stage

Today is **${todayName}**, which is a **${currentStage.name}** day.
Focus on: ${currentStage.description}

When suggesting or prioritizing tasks, prefer tasks tagged with ${currentStage.tag} for today.

### Weekly Schedule

${buildWeeklySchedule()}

### Usage

- Tasks can be tagged with stage tags (e.g., ${stages.front.tag}) to indicate which type of day they're best suited for
- When planning or prioritizing, consider whether the current day's stage aligns with the task type
- It's okay to do tasks from other stages, but the stage system helps batch similar work together`;

console.log(JSON.stringify({
  context,
  metadata: {
    current_day: todayName,
    current_stage: currentStage.name,
    stage_tag: currentStage.tag,
  },
}));

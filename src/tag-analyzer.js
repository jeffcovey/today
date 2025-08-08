#!/usr/bin/env node

import { NotionAPI } from './notion-api.js';
import chalk from 'chalk';
import Table from 'cli-table3';
import inquirer from 'inquirer';

class TagAnalyzer {
  constructor() {
    this.notion = null;
  }

  async initialize() {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error('NOTION_TOKEN environment variable is required');
    }
    this.notion = new NotionAPI(token);
  }

  async getExistingTags() {
    // Use the cached getAllTags method
    const tags = await this.notion.getAllTags();
    
    return tags.map(tag => ({
      id: tag.id,
      name: tag.title // getAllTags already returns formatted objects with title
    }));
  }

  async getUntaggedActionItems(limit = 100) {
    const databases = await this.notion.getDatabases();
    const actionItemsDb = databases.find(db => 
      db.title.toLowerCase().includes('action items')
    );
    
    if (!actionItemsDb) {
      throw new Error('Action Items database not found');
    }

    // First check if we have cached data
    const cached = await this.notion.statusCache.getCachedTasks(actionItemsDb.id);
    
    let allItems;
    if (cached && cached.tasks && cached.tasks.length > 0) {
      console.log('📋 Using cached task data');
      allItems = cached.tasks;
    } else {
      console.log('📋 Fetching fresh task data...');
      // Get all items if no cache available
      allItems = await this.notion.getDatabaseItems(actionItemsDb.id, 100, {
        fetchAll: true,
        filterActionableItems: true,
        useCache: true
      });
    }
    
    // Filter for items without tags
    const untaggedItems = allItems.filter(item => {
      const tagProp = item.properties['Tag/Knowledge Vault'];
      return !tagProp || !tagProp.relation || tagProp.relation.length === 0;
    }).slice(0, limit);

    return untaggedItems.map(item => ({
      id: item.id,
      title: this.notion.extractTitle(item),
      status: item.properties['Status']?.status?.name || 'No status',
      stage: item.properties['Stage']?.select?.name || 'No stage',
      projects: item.properties['Projects (DB)']?.relation?.map(r => r.id) || [],
      doDate: item.properties['Do Date']?.date?.start || null,
      createdTime: item.created_time
    }));
  }

  suggestTags(item, existingTags) {
    const suggestions = [];
    const title = item.title.toLowerCase();
    
    // Keywords mapping to tag names based on your actual tags
    const keywordMappings = {
      // OlderGay.Men related
      'oldergay': ['OlderGay.Men'],
      'ogm': ['OlderGay.Men'],
      'event': ['OlderGay.Men Events'],
      'member': ['OlderGay.Men Members'],
      'group': ['OlderGay.Men Groups'],
      'newsletter': ['OlderGay.Men Newsletter'],
      'patreon': ['OlderGay.Men Patreon'],
      'place': ['OlderGay.Men Places'],
      'story': ['OlderGay.Men Stories'],
      'stories': ['OlderGay.Men Stories'],
      'sysadmin': ['OlderGay.Men Sysadmin'],
      'server': ['OlderGay.Men Sysadmin'],
      'database': ['OlderGay.Men Sysadmin', 'Programming'],
      'spam': ['OlderGay.Men Sysadmin'],
      'spammer': ['OlderGay.Men Sysadmin'],
      'chat': ['OlderGay.Men Chat Room'],
      
      // Health & Wellness
      'health': ['Health'],
      'medical': ['Health', 'Ron\'s Medical Care'],
      'fitness': ['Fitness'],
      'gym': ['Fitness'],
      'exercise': ['Fitness'],
      'diet': ['Nutrition & Diet'],
      'nutrition': ['Nutrition & Diet'],
      'mental': ['Mental Health'],
      'therapy': ['Mental Health'],
      'meditation': ['Meditation & Mindfulness'],
      'mindfulness': ['Meditation & Mindfulness'],
      
      // Personal Life
      'family': ['Family'],
      'friend': ['Friends/Socializing'],
      'social': ['Friends/Socializing'],
      'relationship': ['Relationships'],
      'cat': ['Cats'],
      'pet': ['Cats'],
      
      // Home & Travel
      'home': ['Home/Household'],
      'house': ['Home/Household'],
      'clean': ['Home/Household'],
      'yard': ['Yard/Pool/Landscaping'],
      'pool': ['Yard/Pool/Landscaping'],
      'landscape': ['Yard/Pool/Landscaping'],
      'garden': ['Yard/Pool/Landscaping'],
      'travel': ['Travel'],
      'trip': ['Travel'],
      'explore': ['Local Exploration & Adventure'],
      'adventure': ['Local Exploration & Adventure'],
      'hosting': ['Hosting'],
      'housesit': ['Housesitting'],
      
      // Finance & Admin
      'budget': ['Budgeting'],
      'finance': ['Personal Finance'],
      'money': ['Personal Finance'],
      'bill': ['Personal Admin'],
      'admin': ['Personal Admin'],
      'tax': ['Personal Admin'],
      
      // Technology & Work
      'program': ['Programming'],
      'code': ['Programming'],
      'software': ['Programming'],
      'computer': ['Computers/Hardware'],
      'hardware': ['Computers/Hardware'],
      'windows': ['Windows'],
      'solar': ['Solar Energy'],
      
      // Personal Development
      'productivity': ['Productivity'],
      'focus': ['Focus'],
      'mindset': ['Mindset'],
      'psychology': ['Psychology'],
      'language': ['Languages'],
      'learn': ['Languages'],
      
      // Entertainment & Hobbies
      'art': ['Arts, music, and entertainment'],
      'music': ['Arts, music, and entertainment'],
      'entertainment': ['Arts, music, and entertainment'],
      'club': ['Clubs & Memberships'],
      'membership': ['Clubs & Memberships'],
      
      // Marketing & Business
      'marketing': ['Marketing'],
      'team': ['Team Building'],
      
      // Additional keywords from the tasks
      'user': ['OlderGay.Men', 'OlderGay.Men Members'],
      'account': ['OlderGay.Men', 'OlderGay.Men Members'],
      'meetup': ['OlderGay.Men Events'],
      'image': ['OlderGay.Men'],
      'link': ['OlderGay.Men'],
      'fix': ['OlderGay.Men Sysadmin'],
      'check': ['OlderGay.Men Sysadmin'],
      'test': ['OlderGay.Men Sysadmin', 'Programming'],
      'location': ['OlderGay.Men Places'],
      'index': ['OlderGay.Men Sysadmin'],
      'cron': ['OlderGay.Men Sysadmin'],
      'script': ['Programming', 'OlderGay.Men Sysadmin'],
      'gallery': ['OlderGay.Men'],
      'favorite': ['OlderGay.Men'],
      'trust': ['OlderGay.Men Members'],
      'score': ['OlderGay.Men Members']
    };

    // Check for keywords in title
    for (const [keyword, tagSuggestions] of Object.entries(keywordMappings)) {
      if (title.includes(keyword)) {
        tagSuggestions.forEach(tagName => {
          const tag = existingTags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
          if (tag && !suggestions.find(s => s.id === tag.id)) {
            suggestions.push(tag);
          }
        });
      }
    }

    // Stage-based suggestions
    const stageMappings = {
      'Migrated': ['OlderGay.Men', 'OlderGay.Men Sysadmin'],
      'Planning': ['Focus', 'Productivity'],
      'In Progress': ['Focus', 'Productivity'],
      'Review': ['Team Building'],
      'Blocked': ['Personal Admin'],
      'Done': ['Productivity']
    };

    if (item.stage && stageMappings[item.stage]) {
      stageMappings[item.stage].forEach(tagName => {
        const tag = existingTags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
        if (tag && !suggestions.find(s => s.id === tag.id)) {
          suggestions.push(tag);
        }
      });
    }

    // Time-based suggestions
    if (item.doDate) {
      const date = new Date(item.doDate);
      const today = new Date();
      const daysDiff = Math.floor((date - today) / (1000 * 60 * 60 * 24));
      
      if (daysDiff < 0) {
        const overdueTag = existingTags.find(t => t.name.toLowerCase() === 'overdue');
        if (overdueTag && !suggestions.find(s => s.id === overdueTag.id)) {
          suggestions.push(overdueTag);
        }
      } else if (daysDiff <= 7) {
        const urgentTag = existingTags.find(t => t.name.toLowerCase() === 'urgent');
        if (urgentTag && !suggestions.find(s => s.id === urgentTag.id)) {
          suggestions.push(urgentTag);
        }
      }
    }

    return suggestions.slice(0, 3); // Return top 3 suggestions
  }

  async presentItemsForReview(items, existingTags) {
    console.log(chalk.blue.bold('\n📋 Untagged Action Items Review\n'));
    
    const itemsWithSuggestions = items.map(item => ({
      ...item,
      suggestedTags: this.suggestTags(item, existingTags)
    }));

    // Display items in a table
    const table = new Table({
      head: ['#', 'Title', 'Status', 'Stage', 'Suggested Tags'],
      colWidths: [5, 50, 15, 15, 30],
      wordWrap: true
    });

    itemsWithSuggestions.forEach((item, index) => {
      table.push([
        index + 1,
        item.title,
        item.status,
        item.stage || '-',
        item.suggestedTags.map(t => t.name).join(', ') || 'No suggestions'
      ]);
    });

    console.log(table.toString());
    
    return itemsWithSuggestions;
  }

  async reviewAndApproveTags(itemsWithSuggestions, existingTags) {
    const choices = [
      { name: 'Approve all suggestions', value: 'approve_all' },
      { name: 'Review and modify individual items', value: 'review_individual' },
      { name: 'Skip this batch', value: 'skip' }
    ];

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'How would you like to proceed?',
        choices
      }
    ]);

    if (action === 'skip') {
      return [];
    }

    let finalAssignments = [];

    if (action === 'approve_all') {
      finalAssignments = itemsWithSuggestions.map(item => ({
        itemId: item.id,
        tagIds: item.suggestedTags.map(t => t.id)
      })).filter(a => a.tagIds.length > 0);
    } else {
      // Review individual items
      for (const item of itemsWithSuggestions) {
        console.log(chalk.yellow(`\nItem: ${item.title}`));
        console.log(`Status: ${item.status}, Stage: ${item.stage || 'None'}`);
        console.log(`Suggested tags: ${item.suggestedTags.map(t => t.name).join(', ') || 'None'}`);

        const { reviewAction } = await inquirer.prompt([
          {
            type: 'list',
            name: 'reviewAction',
            message: 'What would you like to do?',
            choices: [
              { name: 'Accept suggested tags', value: 'accept' },
              { name: 'Select different tags', value: 'select' },
              { name: 'Skip this item', value: 'skip' }
            ]
          }
        ]);

        if (reviewAction === 'accept' && item.suggestedTags.length > 0) {
          finalAssignments.push({
            itemId: item.id,
            tagIds: item.suggestedTags.map(t => t.id)
          });
        } else if (reviewAction === 'select') {
          const { selectedTags } = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selectedTags',
              message: 'Select tags:',
              choices: existingTags.map(t => ({ name: t.name, value: t.id }))
            }
          ]);

          if (selectedTags.length > 0) {
            finalAssignments.push({
              itemId: item.id,
              tagIds: selectedTags
            });
          }
        }
      }
    }

    return finalAssignments;
  }

  async assignTags(assignments) {
    const databases = await this.notion.getDatabases();
    const actionItemsDb = databases.find(db => 
      db.title.toLowerCase().includes('action items')
    );
    
    console.log(chalk.blue(`\nAssigning tags to ${assignments.length} items...`));
    
    for (const assignment of assignments) {
      try {
        await this.notion.updatePage(assignment.itemId, {
          'Tag/Knowledge Vault': {
            relation: assignment.tagIds.map(id => ({ id }))
          }
        });
        console.log(chalk.green('✓ Tagged item successfully'));
      } catch (error) {
        console.error(chalk.red(`✗ Failed to tag item: ${error.message}`));
      }
    }
  }

  async run() {
    try {
      await this.initialize();
      
      // Get existing tags
      console.log(chalk.blue('Loading existing tags...'));
      const existingTags = await this.getExistingTags();
      console.log(chalk.green(`✓ Found ${existingTags.length} tags`));

      // Get untagged items
      console.log(chalk.blue('Fetching untagged action items...'));
      const untaggedItems = await this.getUntaggedActionItems(100);
      console.log(chalk.green(`✓ Found ${untaggedItems.length} untagged items`));

      if (untaggedItems.length === 0) {
        console.log(chalk.yellow('No untagged items found!'));
        return;
      }

      // Present items for review
      const itemsWithSuggestions = await this.presentItemsForReview(untaggedItems, existingTags);
      
      // Get user approval
      const assignments = await this.reviewAndApproveTags(itemsWithSuggestions, existingTags);
      
      if (assignments.length > 0) {
        // Assign tags
        await this.assignTags(assignments);
        console.log(chalk.green.bold(`\n✓ Successfully processed ${assignments.length} items!`));
      } else {
        console.log(chalk.yellow('\nNo tags were assigned.'));
      }

      // Ask if user wants to continue with next batch
      const { continueProcessing } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueProcessing',
          message: 'Would you like to process the next batch?',
          default: false
        }
      ]);

      if (continueProcessing) {
        await this.run();
      }

    } catch (error) {
      console.error(chalk.red('Error:', error.message));
      process.exit(1);
    }
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const analyzer = new TagAnalyzer();
  analyzer.run();
}

export { TagAnalyzer };
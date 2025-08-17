#!/usr/bin/env node

import { NotionAPI } from './notion-api.js';
import chalk from 'chalk';
import Table from 'cli-table3';
import inquirer from 'inquirer';

class TopicAnalyzer {
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

  async getExistingTopics() {
    // Use the cached getAllTopics method
    const topics = await this.notion.getAllTopics();
    
    return topics.map(topic => ({
      id: topic.id,
      name: topic.title // getAllTopics already returns formatted objects with title
    }));
  }

  async getUntopicedActionItems(limit = 100) {
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
    
    // Filter for items without topics
    const untopicedItems = allItems.filter(item => {
      const topicProp = item.properties['Topic/Knowledge Vault'];
      return !topicProp || !topicProp.relation || topicProp.relation.length === 0;
    }).slice(0, limit);

    return untopicedItems.map(item => ({
      id: item.id,
      title: this.notion.extractTitle(item),
      status: item.properties['Status']?.status?.name || 'No status',
      stage: item.properties['Stage']?.select?.name || 'No stage',
      projects: item.properties['Projects (DB)']?.relation?.map(r => r.id) || [],
      doDate: item.properties['Do Date']?.date?.start || null,
      createdTime: item.created_time
    }));
  }

  suggestTopics(item, existingTopics) {
    const suggestions = [];
    const title = item.title.toLowerCase();
    
    // Keywords mapping to topic names based on your actual topics
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
          const topic = existingTopics.find(t => t.name.toLowerCase() === tagName.toLowerCase());
          if (topic && !suggestions.find(s => s.id === topic.id)) {
            suggestions.push(topic);
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
        const topic = existingTopics.find(t => t.name.toLowerCase() === tagName.toLowerCase());
        if (topic && !suggestions.find(s => s.id === topic.id)) {
          suggestions.push(topic);
        }
      });
    }

    // Time-based suggestions
    if (item.doDate) {
      const date = new Date(item.doDate);
      const today = new Date();
      const daysDiff = Math.floor((date - today) / (1000 * 60 * 60 * 24));
      
      if (daysDiff < 0) {
        const overdueTopic = existingTopics.find(t => t.name.toLowerCase() === 'overdue');
        if (overdueTopic && !suggestions.find(s => s.id === overdueTopic.id)) {
          suggestions.push(overdueTopic);
        }
      } else if (daysDiff <= 7) {
        const urgentTopic = existingTopics.find(t => t.name.toLowerCase() === 'urgent');
        if (urgentTopic && !suggestions.find(s => s.id === urgentTopic.id)) {
          suggestions.push(urgentTopic);
        }
      }
    }

    return suggestions.slice(0, 3); // Return top 3 suggestions
  }

  async presentItemsForReview(items, existingTopics) {
    console.log(chalk.blue.bold('\n📋 Untopiced Action Items Review\n'));
    
    const itemsWithSuggestions = items.map(item => ({
      ...item,
      suggestedTopics: this.suggestTopics(item, existingTopics)
    }));

    // Display items in a table
    const table = new Table({
      head: ['#', 'Title', 'Status', 'Stage', 'Suggested Topics'],
      colWidths: [5, 50, 15, 15, 30],
      wordWrap: true
    });

    itemsWithSuggestions.forEach((item, index) => {
      table.push([
        index + 1,
        item.title,
        item.status,
        item.stage || '-',
        item.suggestedTopics.map(t => t.name).join(', ') || 'No suggestions'
      ]);
    });

    console.log(table.toString());
    
    return itemsWithSuggestions;
  }

  async reviewAndApproveTopics(itemsWithSuggestions, existingTopics) {
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
        topicIds: item.suggestedTopics.map(t => t.id)
      })).filter(a => a.topicIds.length > 0);
    } else {
      // Review individual items
      for (const item of itemsWithSuggestions) {
        console.log(chalk.yellow(`\nItem: ${item.title}`));
        console.log(`Status: ${item.status}, Stage: ${item.stage || 'None'}`);
        console.log(`Suggested topics: ${item.suggestedTopics.map(t => t.name).join(', ') || 'None'}`);

        const { reviewAction } = await inquirer.prompt([
          {
            type: 'list',
            name: 'reviewAction',
            message: 'What would you like to do?',
            choices: [
              { name: 'Accept suggested topics', value: 'accept' },
              { name: 'Select different topics', value: 'select' },
              { name: 'Skip this item', value: 'skip' }
            ]
          }
        ]);

        if (reviewAction === 'accept' && item.suggestedTopics.length > 0) {
          finalAssignments.push({
            itemId: item.id,
            topicIds: item.suggestedTopics.map(t => t.id)
          });
        } else if (reviewAction === 'select') {
          const { selectedTopics } = await inquirer.prompt([
            {
              type: 'checkbox',
              name: 'selectedTopics',
              message: 'Select topics:',
              choices: existingTopics.map(t => ({ name: t.name, value: t.id }))
            }
          ]);

          if (selectedTopics.length > 0) {
            finalAssignments.push({
              itemId: item.id,
              topicIds: selectedTopics
            });
          }
        }
      }
    }

    return finalAssignments;
  }

  async assignTopics(assignments) {
    const databases = await this.notion.getDatabases();
    const actionItemsDb = databases.find(db => 
      db.title.toLowerCase().includes('action items')
    );
    
    console.log(chalk.blue(`\nAssigning topics to ${assignments.length} items...`));
    
    for (const assignment of assignments) {
      try {
        await this.notion.updatePage(assignment.itemId, {
          'Topic/Knowledge Vault': {
            relation: assignment.topicIds.map(id => ({ id }))
          }
        });
        console.log(chalk.green('✓ Tagged item successfully'));
      } catch (error) {
        console.error(chalk.red(`✗ Failed to topic item: ${error.message}`));
      }
    }
  }

  async run() {
    try {
      await this.initialize();
      
      // Get existing topics
      console.log(chalk.blue('Loading existing topics...'));
      const existingTopics = await this.getExistingTopics();
      console.log(chalk.green(`✓ Found ${existingTopics.length} topics`));

      // Get untopiced items
      console.log(chalk.blue('Fetching untopiced action items...'));
      const untopicedItems = await this.getUntopicedActionItems(100);
      console.log(chalk.green(`✓ Found ${untopicedItems.length} untopiced items`));

      if (untopicedItems.length === 0) {
        console.log(chalk.yellow('No untopiced items found!'));
        return;
      }

      // Present items for review
      const itemsWithSuggestions = await this.presentItemsForReview(untopicedItems, existingTopics);
      
      // Get user approval
      const assignments = await this.reviewAndApproveTopics(itemsWithSuggestions, existingTopics);
      
      if (assignments.length > 0) {
        // Assign topics
        await this.assignTopics(assignments);
        console.log(chalk.green.bold(`\n✓ Successfully processed ${assignments.length} items!`));
      } else {
        console.log(chalk.yellow('\nNo topics were assigned.'));
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
  const analyzer = new TopicAnalyzer();
  analyzer.run();
}

export { TopicAnalyzer };
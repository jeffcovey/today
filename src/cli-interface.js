import inquirer from 'inquirer';
import chalk from 'chalk';

export class CLIInterface {
  constructor(notionAPI) {
    this.notionAPI = notionAPI;
  }

  async start() {
    console.log(chalk.blue.bold('\n🗄️  Notion Action Items Manager\n'));

    // Step 1: Select database (auto-detect Action Items)
    const database = await this.selectDatabase();
    if (!database) return;

    // Step 2: Main menu loop
    while (true) {
      const choice = await this.showMainMenu(database);
      
      switch (choice) {
        case 'stage_assignment':
          await this.handleStageAssignment(database);
          break;
        case 'project_sorting':
          await this.handleProjectSorting(database);
          break;
        case 'tag_assignment':
          await this.handleTagAssignment(database);
          break;
        case 'do_date_editing':
          await this.handleDoDateEditing(database);
          break;
        case 'batch_editing':
          await this.handleBatchEditing(database);
          break;
        case 'exit':
          console.log(chalk.yellow('\n👋 Goodbye!'));
          return;
      }
      
      // Add a separator between operations
      console.log(chalk.gray('\n' + '─'.repeat(50)));
    }
  }

  async selectDatabase() {
    try {
      console.log(chalk.blue('Fetching your databases...'));
      const databases = await this.notionAPI.getDatabases();

      if (databases.length === 0) {
        console.log(chalk.yellow('No databases found. Make sure your integration has access to databases.'));
        return null;
      }

      // Auto-select Action Items database if found
      const actionItemsDB = databases.find(db => 
        db.title.toLowerCase().includes('action items')
      );

      if (actionItemsDB) {
        console.log(chalk.green(`Auto-selected: ${actionItemsDB.title}`));
        return actionItemsDB;
      }

      // If no Action Items database found, show selection
      console.log(chalk.yellow('No "Action Items" database found. Please select one:'));
      const { selectedDatabase } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedDatabase',
          message: 'Select a database to edit:',
          choices: databases.map(db => ({
            name: `${db.title}`,
            value: db
          })),
          pageSize: 10
        }
      ]);

      return selectedDatabase;
    } catch (error) {
      console.error(chalk.red('Failed to fetch databases:'), error.message);
      return null;
    }
  }

  async showMainMenu(database) {
    try {
      // Check for tasks that need Stage assignment and Project assignment
      console.log(chalk.blue('Checking available actions...'));
      const items = await this.notionAPI.getActionableItems(database.id, 100, true);
      
      // Check for tasks without Stage
      const tasksWithoutStage = items.filter(item => {
        const stageProp = item.properties['Stage'];
        return !stageProp || !stageProp.select || !stageProp.select.name;
      });

      // Check for tasks without Project assignment
      const unassignedTasks = items.filter(item => {
        const projectProp = item.properties['Projects (DB)'];
        return !projectProp || !projectProp.relation || projectProp.relation.length === 0;
      });

      // Check for tasks without Tag assignment
      const untaggedTasks = items.filter(item => {
        const tagProp = item.properties['Tag/Knowledge Vault'];
        return !tagProp || !tagProp.relation || tagProp.relation.length === 0;
      });

      // Check for tasks with Do Date set (for editing)
      const tasksWithDoDate = items.filter(item => {
        const doDateProp = item.properties['Do Date'];
        return doDateProp && doDateProp.date && doDateProp.date.start;
      }).sort((a, b) => {
        // Sort by Do Date, soonest first
        const dateA = new Date(a.properties['Do Date'].date.start);
        const dateB = new Date(b.properties['Do Date'].date.start);
        return dateA - dateB;
      });

      // Build menu choices based on available tasks
      const choices = [];

      if (tasksWithoutStage.length > 0) {
        choices.push({ name: `🎭 Assign Stage to tasks (${tasksWithoutStage.length} available)`, value: 'stage_assignment' });
      }

      if (unassignedTasks.length > 0) {
        choices.push({ name: `📁 Sort tasks by project (${unassignedTasks.length} available)`, value: 'project_sorting' });
      }

      if (untaggedTasks.length > 0) {
        choices.push({ name: `🏷️  Assign tags to tasks (${untaggedTasks.length} available)`, value: 'tag_assignment' });
      }

      if (tasksWithDoDate.length > 0) {
        choices.push({ name: `📅 Edit Do Date for tasks (${tasksWithDoDate.length} available)`, value: 'do_date_editing' });
      }

      choices.push({ name: '✏️  Batch edit task properties', value: 'batch_editing' });
      choices.push({ name: '🚪 Exit', value: 'exit' });

      const { choice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'choice',
          message: 'What would you like to do?',
          choices
        }
      ]);
      return choice;
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return 'exit';
      }
      throw error;
    }
  }

  async handleTagAssignment(database) {
    console.log(chalk.blue('\n🏷️  Tag Assignment Mode'));
    
    try {
      // Load all actionable items to find tasks without tags
      console.log(chalk.blue('Loading actionable tasks...'));
      const items = await this.notionAPI.getActionableItems(database.id, 100, true);
      if (items.length === 0) {
        console.log(chalk.yellow('No actionable items found.'));
        return;
      }

      // Get tasks that have no tags assigned
      const untaggedTasks = items.filter(item => {
        const tagProp = item.properties['Tag/Knowledge Vault'];
        return !tagProp || !tagProp.relation || tagProp.relation.length === 0;
      });

      if (untaggedTasks.length === 0) {
        console.log(chalk.yellow('No untagged tasks found. All actionable tasks already have tags assigned.'));
        return;
      }

      console.log(chalk.blue(`\nFound ${untaggedTasks.length} untagged tasks`));

      // Let user select tasks to assign tags to
      const selectedTasks = await this.selectItems(untaggedTasks, `Select tasks to assign tags to`);
      if (selectedTasks.length === 0) return;

      // Load all tags from Tag/Knowledge Vault database
      console.log(chalk.blue('Loading tags...'));
      const tags = await this.notionAPI.getAllTags();
      if (tags.length === 0) {
        console.log(chalk.yellow('No tags found in Tag/Knowledge Vault database.'));
        return;
      }

      console.log(chalk.green(`Found ${tags.length} tags`));

      // Let user select tags to assign
      const selectedTags = await this.selectTags(tags);
      if (!selectedTags || selectedTags.length === 0) return;

      // Verify the selected tags exist by checking their IDs
      for (const tag of selectedTags) {
        try {
          await this.notionAPI.notion.pages.retrieve({ page_id: tag.id });
        } catch (error) {
          console.log(chalk.red(`❌ Tag verification failed: ${tag.title} - ${error.message}`));
          return;
        }
      }

      // Assign tags to selected tasks
      await this.assignTagsToTasks(selectedTasks, selectedTags, database);
    } catch (error) {
      console.error(chalk.red('Error in tag assignment:'), error.message);
      if (error.message.includes('Tag/Knowledge Vault database not found')) {
        console.log(chalk.yellow('Make sure the Notion integration has access to the Tag/Knowledge Vault database.'));
      }
    }
  }

  async handleDoDateEditing(database) {
    console.log(chalk.blue('\n📅 Do Date Editing Mode'));
    
    try {
      // Load all actionable items to find tasks with Do Date set
      console.log(chalk.blue('Loading tasks with Do Date...'));
      const items = await this.notionAPI.getActionableItems(database.id, 100, true);
      if (items.length === 0) {
        console.log(chalk.yellow('No actionable items found.'));
        return;
      }

      // Get tasks that have Do Date set and sort by date
      const tasksWithDoDate = items.filter(item => {
        const doDateProp = item.properties['Do Date'];
        return doDateProp && doDateProp.date && doDateProp.date.start;
      }).sort((a, b) => {
        // Sort by Do Date, soonest first
        const dateA = new Date(a.properties['Do Date'].date.start);
        const dateB = new Date(b.properties['Do Date'].date.start);
        return dateA - dateB;
      });

      if (tasksWithDoDate.length === 0) {
        console.log(chalk.yellow('No tasks with Do Date found.'));
        return;
      }

      console.log(chalk.blue(`\nFound ${tasksWithDoDate.length} tasks with Do Date set (sorted by date)`));

      // Let user select tasks to edit Do Date for
      const selectedTasks = await this.selectItems(tasksWithDoDate, `Select tasks to edit Do Date for`);
      if (selectedTasks.length === 0) return;

      // Let user select a new date using month view picker
      const newDate = await this.selectDateWithMonthView();
      if (!newDate) return;

      // Update Do Date for selected tasks
      await this.updateDoDateForTasks(selectedTasks, newDate, database);
    } catch (error) {
      console.error(chalk.red('Error in Do Date editing:'), error.message);
    }
  }

  async handleStageAssignment(database) {
    console.log(chalk.blue('\n🎭 Stage Assignment Mode'));
    
    try {
      // Load all actionable items to find tasks without Stage
      console.log(chalk.blue('Loading actionable tasks...'));
      const items = await this.notionAPI.getActionableItems(database.id, 100, true);
      if (items.length === 0) {
        console.log(chalk.yellow('No actionable items found.'));
        return;
      }

      // Get tasks that have no Stage set
      const tasksWithoutStage = items.filter(item => {
        const stageProp = item.properties['Stage'];
        return !stageProp || !stageProp.select || !stageProp.select.name;
      });

      if (tasksWithoutStage.length === 0) {
        console.log(chalk.yellow('No tasks without Stage found. All actionable tasks already have a Stage assigned.'));
        return;
      }

      console.log(chalk.blue(`\nFound ${tasksWithoutStage.length} tasks without Stage`));

      // Let user select tasks to assign Stage to
      const selectedTasks = await this.selectItems(tasksWithoutStage, `Select tasks to assign a Stage to`);
      if (selectedTasks.length === 0) return;

      // Get Stage options from database schema
      console.log(chalk.blue('Loading Stage options...'));
      const stageOptions = await this.notionAPI.getStageOptions(database.id);
      if (stageOptions.length === 0) {
        console.log(chalk.yellow('No Stage options found in database.'));
        return;
      }

      // Let user select a Stage
      const selectedStage = await this.selectStage(stageOptions);
      if (!selectedStage) return;

      // Assign Stage to selected tasks
      await this.assignStageToTasks(selectedTasks, selectedStage, database);
    } catch (error) {
      console.error(chalk.red('Error in stage assignment:'), error.message);
      if (error.message.includes('Stage property not found')) {
        console.log(chalk.yellow('Make sure the database has a "Stage" property of type "Select".'));
      }
    }
  }

  async handleProjectSorting(database) {
    console.log(chalk.blue('\n📁 Project Sorting Mode'));
    
    try {
      // Load all projects directly from Projects database
      console.log(chalk.blue('Fetching projects...'));
      const projects = await this.notionAPI.getAllProjects();
      if (projects.length === 0) {
        console.log(chalk.yellow('No projects found in Projects database.'));
        return;
      }

      console.log(chalk.green(`Found ${projects.length} projects`));

      // Let user select a project
      const selectedProject = await this.selectProject(projects);
      if (!selectedProject) return;

      // Load all actionable items to find unassigned tasks
      console.log(chalk.blue('Loading actionable tasks...'));
      const items = await this.notionAPI.getActionableItems(database.id, 100, true); // useCache = true
      if (items.length === 0) {
        console.log(chalk.yellow('No actionable items found.'));
        return;
      }

      // Get tasks that are not assigned to ANY project
      const unassignedTasks = items.filter(item => {
        const projectProp = item.properties['Projects (DB)'];
        
        // Only show tasks with no project assignments at all
        return !projectProp || !projectProp.relation || projectProp.relation.length === 0;
      });

      if (unassignedTasks.length === 0) {
        console.log(chalk.yellow('No unassigned tasks found. All actionable tasks are already assigned to projects.'));
        return;
      }

      console.log(chalk.blue(`\nFound ${unassignedTasks.length} unassigned tasks`));

      // Let user select tasks to assign to the project
      const selectedTasks = await this.selectItems(unassignedTasks, `Select unassigned tasks to assign to "${selectedProject.title}"`);
      if (selectedTasks.length === 0) return;

      // Assign tasks to project
      await this.assignTasksToProject(selectedTasks, selectedProject, database);
    } catch (error) {
      console.error(chalk.red('Error in project sorting:'), error.message);
      if (error.message.includes('Projects database not found')) {
        console.log(chalk.yellow('Make sure the Notion integration has access to the Projects database.'));
      }
    }
  }

  async handleBatchEditing(database) {
    console.log(chalk.blue('\n✏️  Batch Editing Mode'));
    
    // Step 2: Load database schema and items
    const schema = await this.notionAPI.getDatabaseSchema(database.id);
    const items = await this.notionAPI.getActionableItems(database.id);

    if (items.length === 0) {
      console.log(chalk.yellow('No actionable items found (excluding completed tasks).'));
      return;
    }

    console.log(chalk.blue(`\nFound ${items.length} actionable items (excluding completed, sorted by most recent)`));

    // Step 3: Select items to edit
    let selectedItems = await this.selectItems(items, 'Select items to edit');
    if (selectedItems.length === 0) return;

    console.log(chalk.green(`\nSelected ${selectedItems.length} items for editing`));

    // Step 4: Select properties to edit
    const editableProperties = this.getEditableProperties(schema.properties);
    if (editableProperties.length === 0) {
      console.log(chalk.yellow('No editable properties found in this database.'));
      return;
    }

    let propertiesToEdit = await this.selectProperties(editableProperties);
    if (propertiesToEdit.length === 0) {
      // User pressed ESC, go back to item selection
      console.log(chalk.blue('\n← Going back to item selection...'));
      selectedItems = await this.selectItems(items, 'Select items to edit');
      if (selectedItems.length === 0) return;
      
      console.log(chalk.green(`\nSelected ${selectedItems.length} items for editing`));
      propertiesToEdit = await this.selectProperties(editableProperties);
      if (propertiesToEdit.length === 0) return;
    }

    // Step 5: Get new values for selected properties
    const newValues = await this.getNewValues(propertiesToEdit, schema.properties);

    // Step 6: Confirm and execute batch update
    await this.confirmAndExecute(selectedItems, newValues, propertiesToEdit);
  }

  async selectItems(items, message = 'Select items to edit') {
    try {
      // Go directly to item selection interface
      const choices = [
        ...items.map(item => {
          const createdDate = this.formatCreatedDate(item.created_time);
          
          // Check if this item has a Do Date and format it
          let doDateStr = '';
          const doDateProp = item.properties['Do Date'];
          if (doDateProp && doDateProp.date && doDateProp.date.start) {
            const doDate = new Date(doDateProp.date.start);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            doDate.setHours(0, 0, 0, 0);
            
            const diffDays = Math.floor((doDate - today) / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
              doDateStr = chalk.red(' [Due Today]');
            } else if (diffDays === 1) {
              doDateStr = chalk.yellow(' [Due Tomorrow]');
            } else if (diffDays < 0) {
              doDateStr = chalk.red(` [Overdue by ${Math.abs(diffDays)} days]`);
            } else if (diffDays <= 7) {
              doDateStr = chalk.yellow(` [Due in ${diffDays} days]`);
            } else {
              doDateStr = chalk.gray(` [Due ${doDate.toLocaleDateString()}]`);
            }
          }
          
          const displayName = `${item.title}${doDateStr} ${createdDate}`;
          
          return {
            name: displayName,
            value: item,
            checked: false
          };
        }),
        new inquirer.Separator(),
        { name: '← Cancel', value: '__cancel__', checked: false }
      ];

      const { selectedItems } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selectedItems',
          message: `${message} (${items.length} items, use spacebar to select, enter to confirm):`,
          choices,
          pageSize: 15,
          validate: (input) => {
            if (input.includes('__cancel__')) {
              return true; // Allow cancel selection
            }
            if (input.length === 0) {
              return 'Please select at least one item or choose Cancel';
            }
            return true;
          }
        }
      ]);

      // Check if user selected cancel
      if (selectedItems.includes('__cancel__')) {
        return [];
      }

      return selectedItems.filter(item => item !== '__cancel__');
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        console.log(chalk.yellow('\n👋 Goodbye!'));
        process.exit(0);
      }
      throw error;
    }
  }

  async searchAndFilter(items, options = {}) {
    const {
      title = 'Items',
      searchFields = ['title'],
      displayFormatter = (item, index) => {
        const createdDate = item.created_time ? this.formatCreatedDate(item.created_time) : '';
        return `${index + 1}. ${item.title || item.name} ${chalk.gray(createdDate)}`;
      },
      maxPreview = 10
    } = options;

    let searchTerm = '';
    let filteredItems = items;

    while (true) {
      // Show current search results
      console.clear();
      console.log(chalk.blue.bold(`🔍 Search and Filter ${title}\n`));
      
      if (searchTerm) {
        console.log(chalk.blue(`Search: "${searchTerm}"`));
        console.log(chalk.green(`Found ${filteredItems.length} matching ${title.toLowerCase()}\n`));
      } else {
        console.log(chalk.gray('Type to search, or press Enter to use current results\n'));
      }

      // Show preview of current results
      const preview = filteredItems.slice(0, maxPreview);
      preview.forEach((item, index) => {
        console.log(chalk.white(displayFormatter(item, index)));
      });

      if (filteredItems.length > maxPreview) {
        console.log(chalk.gray(`... and ${filteredItems.length - maxPreview} more ${title.toLowerCase()}`));
      }

      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: '✏️  Modify search term', value: 'search' },
            { name: '✅ Use these results', value: 'use', disabled: filteredItems.length === 0 },
            { name: '🔄 Reset search', value: 'reset' },
            { name: '← Go back', value: 'back' }
          ]
        }
      ]);

      switch (action) {
        case 'search':
          const { newSearchTerm } = await inquirer.prompt([
            {
              type: 'input',
              name: 'newSearchTerm',
              message: 'Enter search term:',
              default: searchTerm
            }
          ]);
          
          searchTerm = newSearchTerm.toLowerCase();
          filteredItems = items.filter(item => 
            searchFields.some(field => {
              const value = field.includes('.') 
                ? field.split('.').reduce((obj, key) => obj?.[key], item)
                : item[field];
              return value && value.toString().toLowerCase().includes(searchTerm);
            })
          );
          break;

        case 'use':
          return filteredItems;

        case 'reset':
          searchTerm = '';
          filteredItems = items;
          break;

        case 'back':
          return [];
      }
    }
  }

  // Convenience method for items (tasks)
  async searchAndFilterItems(items) {
    return this.searchAndFilter(items, {
      title: 'Items',
      searchFields: ['title'],
      displayFormatter: (item, index) => {
        const createdDate = this.formatCreatedDate(item.created_time);
        return `${index + 1}. ${item.title} ${chalk.gray(createdDate)}`;
      }
    });
  }

  getEditableProperties(properties) {
    const editableTypes = [
      'title', 'rich_text', 'number', 'select', 'multi_select', 
      'date', 'checkbox', 'url', 'email', 'phone_number'
    ];

    return Object.entries(properties)
      .filter(([name, prop]) => editableTypes.includes(prop.type))
      .map(([name, prop]) => ({ name, ...prop }));
  }

  async selectProperties(editableProperties) {
    try {
      const choices = [
        ...editableProperties.map(prop => ({
          name: `${prop.name} (${prop.type})`,
          value: prop
        })),
        new inquirer.Separator(),
        { name: '← Go back', value: '__cancel__' }
      ];

      const { selectedProperties } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selectedProperties',
          message: 'Select properties to edit:',
          choices,
          validate: (input) => {
            if (input.includes('__cancel__')) {
              return true; // Allow cancel selection
            }
            if (input.length === 0) {
              return 'Please select at least one property or choose Go back';
            }
            return true;
          }
        }
      ]);

      // Check if user selected cancel
      if (selectedProperties.includes('__cancel__')) {
        return [];
      }

      return selectedProperties.filter(prop => prop !== '__cancel__');
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return []; // Return empty array to indicate user wants to go back
      }
      throw error;
    }
  }

  async getNewValues(propertiesToEdit, allProperties) {
    const newValues = {};

    for (const property of propertiesToEdit) {
      const value = await this.getValueForProperty(property, allProperties);
      if (value !== null) {
        newValues[property.name] = value;
      }
    }

    return newValues;
  }

  async getValueForProperty(property, allProperties) {
    const propertySchema = allProperties[property.name];

    try {
      switch (property.type) {
        case 'title':
        case 'rich_text':
          const { textValue } = await inquirer.prompt([
            {
              type: 'input',
              name: 'textValue',
              message: `Enter new value for ${property.name} (ESC to skip):`,
              validate: (input) => input.trim().length > 0 || 'Value cannot be empty'
            }
          ]);
          return property.type === 'title' 
            ? { title: [{ text: { content: textValue } }] }
            : { rich_text: [{ text: { content: textValue } }] };

        case 'number':
          const { numberValue } = await inquirer.prompt([
            {
              type: 'number',
              name: 'numberValue',
              message: `Enter new number for ${property.name} (ESC to skip):`
            }
          ]);
          return { number: numberValue };

        case 'checkbox':
          const { checkboxValue } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'checkboxValue',
              message: `Set ${property.name} to (ESC to skip):`
            }
          ]);
          return { checkbox: checkboxValue };

        case 'url':
        case 'email':
        case 'phone_number':
          const { stringValue } = await inquirer.prompt([
            {
              type: 'input',
              name: 'stringValue',
              message: `Enter new ${property.type} for ${property.name} (ESC to skip):`
            }
          ]);
          return { [property.type]: stringValue };

        case 'date':
          const { dateValue } = await inquirer.prompt([
            {
              type: 'input',
              name: 'dateValue',
              message: `Enter new date for ${property.name} (YYYY-MM-DD, ESC to skip):`,
              validate: (input) => {
                if (!input) return true; // Allow empty
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                return dateRegex.test(input) || 'Please enter date in YYYY-MM-DD format';
              }
            }
          ]);
          return dateValue ? { date: { start: dateValue } } : null;

        default:
          console.log(chalk.yellow(`Skipping ${property.name} - ${property.type} editing not yet supported`));
          return null;
      }
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        console.log(chalk.yellow(`Skipped ${property.name}`));
        return null;
      }
      throw error;
    }
  }

  async confirmAndExecute(selectedItems, newValues, propertiesToEdit) {
    console.log(chalk.blue('\n📝 Batch Update Summary:'));
    console.log(chalk.white(`Items to update: ${selectedItems.length}`));
    console.log(chalk.white('Properties to change:'));
    
    for (const prop of propertiesToEdit) {
      if (newValues[prop.name]) {
        console.log(chalk.white(`  - ${prop.name}: ${this.formatValueForDisplay(newValues[prop.name], prop.type)}`));
      }
    }

    try {
      const { confirm } = await inquirer.prompt([
        {
          type: 'list',
          name: 'confirm',
          message: chalk.yellow('Proceed with batch update?'),
          choices: [
            { name: '✅ Yes, update all items', value: true },
            { name: '❌ No, cancel operation', value: false }
          ],
          default: 1 // Default to "No"
        }
      ]);

      if (!confirm) {
        console.log(chalk.blue('Operation cancelled.'));
        return;
      }
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        console.log(chalk.blue('\nOperation cancelled.'));
        return;
      }
      throw error;
    }

    console.log(chalk.blue('\n🔄 Updating items...'));

    const updates = selectedItems.map(item => ({
      pageId: item.id,
      properties: newValues
    }));

    try {
      const results = await this.notionAPI.batchUpdatePages(updates);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(chalk.green(`\n✅ Successfully updated ${successful} items`));
      
      // Update cache for successfully updated tasks to reflect changes
      if (successful > 0) {
        const successfulTaskIds = results
          .filter(r => r.success)
          .map(r => r.pageId);
        
        try {
          const updatedTasks = await this.notionAPI.getUpdatedTasks(successfulTaskIds);
          await this.notionAPI.statusCache.updateTasksInCache(database.id, updatedTasks);
          console.log(chalk.blue(`🔄 Updated ${successfulTaskIds.length} tasks in cache`));
        } catch (error) {
          // Fall back to full cache invalidation if targeted update fails
          await this.notionAPI.statusCache.invalidateTaskCache();
          console.log(chalk.blue('🔄 Cache refreshed'));
        }
      }
      
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to update ${failed} items`));
        const failedResults = results.filter(r => !r.success);
        for (const result of failedResults) {
          console.log(chalk.red(`  - ${result.pageId}: ${result.error}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Batch update failed:'), error.message);
    }
  }

  formatValueForDisplay(value, type) {
    switch (type) {
      case 'title':
      case 'rich_text':
        return value[type][0]?.text?.content || '';
      case 'number':
        return value.number;
      case 'checkbox':
        return value.checkbox ? 'Yes' : 'No';
      case 'date':
        return value.date?.start || '';
      default:
        return value[type] || '';
    }
  }

  getItemStatus(item) {
    const statusProperty = item.properties?.Status || item.properties?.status;
    if (statusProperty?.type === 'status') {
      return statusProperty.status?.name;
    }
    if (statusProperty?.type === 'select') {
      return statusProperty.select?.name;
    }
    return null;
  }

  getAllStatusInfo(item) {
    const statuses = [];
    for (const [propName, propValue] of Object.entries(item.properties)) {
      if (propValue.type === 'status' && propValue.status?.name) {
        statuses.push(`${propName}: ${propValue.status.name}`);
      }
    }
    return statuses.length > 0 ? statuses.join(' | ') : '';
  }

  formatCreatedDate(createdTime) {
    if (!createdTime) return '';
    const date = new Date(createdTime);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return '(today)';
    if (diffDays === 1) return '(yesterday)';
    if (diffDays < 7) return `(${diffDays} days ago)`;
    
    return `(${date.toLocaleDateString()})`;
  }

  async selectDateWithMonthView() {
    try {
      const currentDate = new Date();
      let selectedYear = currentDate.getFullYear();
      let selectedMonth = currentDate.getMonth(); // 0-11
      let selectedDay = currentDate.getDate();

      while (true) {
        // Clear screen and show month view
        console.clear();
        console.log(chalk.blue.bold(`📅 Select Date - Use Arrow Keys to Navigate\n`));
        
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'];
        
        console.log(chalk.cyan(`${monthNames[selectedMonth]} ${selectedYear}`));
        console.log(chalk.gray('Su Mo Tu We Th Fr Sa'));
        
        // Calculate first day of month and number of days
        const firstDay = new Date(selectedYear, selectedMonth, 1).getDay();
        const daysInMonth = new Date(selectedYear, selectedMonth + 1, 0).getDate();
        
        // Build calendar grid
        let calendar = '';
        let dayCounter = 1;
        
        // First week with padding
        for (let i = 0; i < 7; i++) {
          if (i < firstDay) {
            calendar += '   '; // Empty space for days before month starts
          } else {
            const day = dayCounter++;
            const isSelected = day === selectedDay;
            const dayStr = day.toString().padStart(2, ' ');
            
            if (isSelected) {
              calendar += chalk.bgBlue.white(` ${dayStr} `);
            } else {
              calendar += ` ${dayStr} `;
            }
          }
        }
        calendar += '\n';
        
        // Remaining weeks
        while (dayCounter <= daysInMonth) {
          for (let i = 0; i < 7 && dayCounter <= daysInMonth; i++) {
            const day = dayCounter++;
            const isSelected = day === selectedDay;
            const dayStr = day.toString().padStart(2, ' ');
            
            if (isSelected) {
              calendar += chalk.bgBlue.white(` ${dayStr} `);
            } else {
              calendar += ` ${dayStr} `;
            }
          }
          calendar += '\n';
        }
        
        console.log(calendar);
        console.log(chalk.yellow('Arrow Keys: Navigate | Enter: Select | Esc: Cancel | M: Change Month | Y: Change Year'));
        
        const selectedDate = new Date(selectedYear, selectedMonth, selectedDay);
        console.log(chalk.green(`Selected: ${selectedDate.toLocaleDateString()}`));

        // Get user input
        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'Navigate:',
            choices: [
              { name: '← Previous Day', value: 'prev_day' },
              { name: '→ Next Day', value: 'next_day' },
              { name: '↑ Previous Week', value: 'prev_week' },
              { name: '↓ Next Week', value: 'next_week' },
              { name: '← Previous Month', value: 'prev_month' },
              { name: '→ Next Month', value: 'next_month' },
              { name: '📅 Change Year', value: 'change_year' },
              { name: '✅ Select This Date', value: 'select' },
              { name: '❌ Cancel', value: 'cancel' }
            ],
            pageSize: 12
          }
        ]);

        switch (action) {
          case 'prev_day':
            selectedDay--;
            if (selectedDay < 1) {
              selectedMonth--;
              if (selectedMonth < 0) {
                selectedMonth = 11;
                selectedYear--;
              }
              selectedDay = new Date(selectedYear, selectedMonth + 1, 0).getDate();
            }
            break;
            
          case 'next_day':
            selectedDay++;
            const maxDays = new Date(selectedYear, selectedMonth + 1, 0).getDate();
            if (selectedDay > maxDays) {
              selectedDay = 1;
              selectedMonth++;
              if (selectedMonth > 11) {
                selectedMonth = 0;
                selectedYear++;
              }
            }
            break;
            
          case 'prev_week':
            selectedDay -= 7;
            if (selectedDay < 1) {
              selectedMonth--;
              if (selectedMonth < 0) {
                selectedMonth = 11;
                selectedYear--;
              }
              const prevMonthDays = new Date(selectedYear, selectedMonth + 1, 0).getDate();
              selectedDay = prevMonthDays + selectedDay;
            }
            break;
            
          case 'next_week':
            selectedDay += 7;
            const maxDaysNext = new Date(selectedYear, selectedMonth + 1, 0).getDate();
            if (selectedDay > maxDaysNext) {
              selectedDay = selectedDay - maxDaysNext;
              selectedMonth++;
              if (selectedMonth > 11) {
                selectedMonth = 0;
                selectedYear++;
              }
            }
            break;
            
          case 'prev_month':
            selectedMonth--;
            if (selectedMonth < 0) {
              selectedMonth = 11;
              selectedYear--;
            }
            // Adjust day if it doesn't exist in new month
            const newMaxDays = new Date(selectedYear, selectedMonth + 1, 0).getDate();
            if (selectedDay > newMaxDays) {
              selectedDay = newMaxDays;
            }
            break;
            
          case 'next_month':
            selectedMonth++;
            if (selectedMonth > 11) {
              selectedMonth = 0;
              selectedYear++;
            }
            // Adjust day if it doesn't exist in new month
            const newMaxDaysNext = new Date(selectedYear, selectedMonth + 1, 0).getDate();
            if (selectedDay > newMaxDaysNext) {
              selectedDay = newMaxDaysNext;
            }
            break;
            
          case 'change_year':
            const { year } = await inquirer.prompt([
              {
                type: 'number',
                name: 'year',
                message: 'Enter year:',
                default: selectedYear,
                validate: (input) => {
                  return input >= 2020 && input <= 2030 ? true : 'Please enter a year between 2020 and 2030';
                }
              }
            ]);
            selectedYear = year;
            break;
            
          case 'select':
            return new Date(selectedYear, selectedMonth, selectedDay).toISOString().split('T')[0];
            
          case 'cancel':
            return null;
        }
      }
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return null;
      }
      throw error;
    }
  }

  async updateDoDateForTasks(tasks, newDate, database) {
    console.log(chalk.blue(`\n🔄 Updating Do Date to ${newDate} for ${tasks.length} tasks...`));
    
    const updates = tasks.map(task => ({
      pageId: task.id,
      properties: {
        'Do Date': {
          date: { start: newDate }
        }
      }
    }));

    try {
      const results = await this.notionAPI.batchUpdatePages(updates);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(chalk.green(`\n✅ Successfully updated Do Date for ${successful} tasks`));
      
      if (successful > 0) {
        // Update cache
        try {
          const successfulTaskIds = results
            .filter(r => r.success)
            .map(r => r.pageId);
          
          const updatedTasks = await this.notionAPI.getUpdatedTasks(successfulTaskIds);
          await this.notionAPI.statusCache.updateTasksInCache(database.id, updatedTasks);
          console.log(chalk.blue(`🔄 Updated ${successfulTaskIds.length} tasks in cache`));
        } catch (error) {
          await this.notionAPI.statusCache.invalidateTaskCache();
          console.log(chalk.blue('🔄 Cache refreshed'));
        }
      }
      
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to update Do Date for ${failed} tasks`));
        const failedResults = results.filter(r => !r.success);
        for (const result of failedResults) {
          console.log(chalk.red(`  - ${result.pageId}: ${result.error}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Do Date update failed:'), error.message);
    }
  }


  async selectProject(projects) {
    try {
      const choices = [
        ...projects.map(project => ({
          name: project.status ? `${project.title} (${project.status})` : project.title,
          value: project
        })),
        { name: '← Back to main menu', value: null }
      ];

      const { selectedProject } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedProject',
          message: `Select a project to assign tasks to (${projects.length} projects):`,
          choices,
          pageSize: 15
        }
      ]);

      return selectedProject;
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return null;
      }
      throw error;
    }
  }

  async searchAndFilterProjects(projects) {
    return this.searchAndFilter(projects, {
      title: 'Projects',
      searchFields: ['title', 'status'],
      displayFormatter: (project, index) => {
        const status = project.status ? ` (${project.status})` : '';
        return `${index + 1}. ${project.title}${chalk.gray(status)}`;
      }
    });
  }

  async selectStage(stageOptions) {
    try {
      const choices = [
        ...stageOptions.map(stage => ({
          name: stage.name,
          value: stage
        })),
        { name: '← Back to main menu', value: null }
      ];

      const { selectedStage } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedStage',
          message: `Select a Stage to assign to selected tasks (${stageOptions.length} stages):`,
          choices
        }
      ]);

      return selectedStage;
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return null;
      }
      throw error;
    }
  }

  async searchAndFilterStages(stages) {
    return this.searchAndFilter(stages, {
      title: 'Stages',
      searchFields: ['name'],
      displayFormatter: (stage, index) => `${index + 1}. ${stage.name}`,
      maxPreview: 20 // Stages typically have shorter names, show more
    });
  }

  async selectWithSearch(items, options = {}) {
    const {
      message = 'Select an item',
      searchThreshold = 10,
      searchOptions = {},
      formatChoice = (item) => ({ name: item.title || item.name, value: item }),
      includeCancel = true,
      cancelText = '← Back to main menu'
    } = options;

    try {
      let filteredItems = items;
      
      // Only offer search if there are more items than threshold
      if (items.length > searchThreshold) {
        const { searchChoice } = await inquirer.prompt([
          {
            type: 'list',
            name: 'searchChoice',
            message: `${message} - How would you like to proceed?`,
            choices: [
              { name: '🔍 Search and filter', value: 'search' },
              { name: '📋 Browse all', value: 'browse' },
              ...(includeCancel ? [{ name: cancelText, value: 'cancel' }] : [])
            ]
          }
        ]);

        if (searchChoice === 'cancel') {
          return null;
        }

        if (searchChoice === 'search') {
          filteredItems = await this.searchAndFilter(items, searchOptions);
          if (filteredItems.length === 0) {
            console.log(chalk.yellow('No items match your search. Returning to previous menu.'));
            return null;
          }
        }
      }

      const choices = [
        ...filteredItems.map(formatChoice),
        ...(includeCancel ? [{ name: cancelText, value: null }] : [])
      ];

      const result = await inquirer.prompt([
        {
          type: 'list',
          name: 'selection',
          message: items.length > searchThreshold 
            ? `${message} (${filteredItems.length} shown):`
            : `${message}:`,
          choices,
          pageSize: 15
        }
      ]);

      return result.selection;
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return null;
      }
      throw error;
    }
  }

  async selectTags(tags) {
    try {
      // Show multiple selection interface for tags
      const choices = [
        ...tags.map(tag => ({
          name: tag.title,
          value: tag,
          checked: false
        })),
        new inquirer.Separator(),
        { name: '← Cancel', value: '__cancel__', checked: false }
      ];

      const { selectedTags } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'selectedTags',
          message: `Select tags to assign (${tags.length} tags, use spacebar to select, enter to confirm):`,
          choices,
          pageSize: 15,
          validate: (input) => {
            if (input.includes('__cancel__')) {
              return true; // Allow cancel selection
            }
            if (input.length === 0) {
              return 'Please select at least one tag or choose Cancel';
            }
            return true;
          }
        }
      ]);

      // Check if user selected cancel
      if (selectedTags.includes('__cancel__')) {
        return [];
      }

      return selectedTags.filter(tag => tag !== '__cancel__');
    } catch (error) {
      if (error.isTtyError || error.message.includes('User force closed')) {
        return null;
      }
      throw error;
    }
  }

  async assignTagsToTasks(tasks, tags, database) {
    const tagNames = Array.isArray(tags) ? tags.map(tag => tag.title).join(', ') : tags.title;
    const tagArray = Array.isArray(tags) ? tags : [tags];
    
    console.log(chalk.blue(`\n🔄 Assigning tags "${tagNames}" to ${tasks.length} tasks...`));

    const updates = tasks.map(task => ({
      pageId: task.id,
      properties: {
        'YubG': {  // Use property ID directly
          relation: tagArray.map(tag => ({ id: tag.id }))
        }
      }
    }));

    try {
      const results = await this.notionAPI.batchUpdatePages(updates);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(chalk.green(`\n✅ Successfully assigned tags "${tagNames}" to ${successful} tasks`));
      
      // Update cache for successfully assigned tasks to reflect the new tag relations
      if (successful > 0) {
        const successfulTaskIds = results
          .filter(r => r.success)
          .map(r => r.pageId);
        
        try {
          const updatedTasks = await this.notionAPI.getUpdatedTasks(successfulTaskIds);
          await this.notionAPI.statusCache.updateTasksInCache(database.id, updatedTasks);
          console.log(chalk.blue(`🔄 Updated ${successfulTaskIds.length} tasks in cache`));
          
          // Verify tag assignment by checking the first updated task
          if (updatedTasks.length > 0) {
            const firstTask = updatedTasks[0];
            const tagProp = firstTask.properties['Tag/Knowledge Vault'];
            if (tagProp && tagProp.relation && tagProp.relation.length > 0) {
              console.log(chalk.green(`✅ Verified: Tags successfully applied to task "${firstTask.title}"`));
            } else {
              console.log(chalk.yellow(`⚠️  Warning: Tag assignment may not have been applied to task "${firstTask.title}"`));
              console.log(chalk.gray(`Debug task with: node src/index.js debug --task-id ${firstTask.id}`));
            }
          }
        } catch (error) {
          // Fall back to full cache invalidation if targeted update fails
          await this.notionAPI.statusCache.invalidateTaskCache();
          console.log(chalk.blue('🔄 Cache refreshed'));
        }
      }
      
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to assign tags to ${failed} tasks`));
        const failedResults = results.filter(r => !r.success);
        for (const result of failedResults) {
          console.log(chalk.red(`  - ${result.pageId}: ${result.error}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Tag assignment failed:'), error.message);
    }
  }

  async assignStageToTasks(tasks, stage, database) {
    console.log(chalk.blue(`\n🔄 Assigning Stage "${stage.name}" to ${tasks.length} tasks...`));

    const updates = tasks.map(task => ({
      pageId: task.id,
      properties: {
        'Stage': {
          select: { id: stage.id }
        }
      }
    }));

    try {
      const results = await this.notionAPI.batchUpdatePages(updates);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(chalk.green(`\n✅ Successfully assigned Stage "${stage.name}" to ${successful} tasks`));
      
      // Update cache for successfully assigned tasks to reflect the new Stage values
      if (successful > 0) {
        const successfulTaskIds = results
          .filter(r => r.success)
          .map(r => r.pageId);
        
        try {
          const updatedTasks = await this.notionAPI.getUpdatedTasks(successfulTaskIds);
          await this.notionAPI.statusCache.updateTasksInCache(database.id, updatedTasks);
          console.log(chalk.blue(`🔄 Updated ${successfulTaskIds.length} tasks in cache`));
        } catch (error) {
          // Fall back to full cache invalidation if targeted update fails
          await this.notionAPI.statusCache.invalidateTaskCache();
          console.log(chalk.blue('🔄 Cache refreshed'));
        }
      }
      
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to assign Stage to ${failed} tasks`));
        const failedResults = results.filter(r => !r.success);
        for (const result of failedResults) {
          console.log(chalk.red(`  - ${result.pageId}: ${result.error}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Stage assignment failed:'), error.message);
    }
  }

  async assignTasksToProject(tasks, project, database) {
    console.log(chalk.blue(`\n🔄 Assigning ${tasks.length} unassigned tasks to "${project.title}"...`));

    // Since we're only dealing with unassigned tasks, we can simply assign the project
    const updates = tasks.map(task => ({
      pageId: task.id,
      properties: {
        'Projects (DB)': {
          relation: [{ id: project.id }]
        }
      }
    }));

    try {
      const results = await this.notionAPI.batchUpdatePages(updates);
      
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(chalk.green(`\n✅ Successfully assigned ${successful} tasks to "${project.title}"`));
      
      // Update cache for successfully assigned tasks to reflect the new project relations
      if (successful > 0) {
        const successfulTaskIds = results
          .filter(r => r.success)
          .map(r => r.pageId);
        
        try {
          const updatedTasks = await this.notionAPI.getUpdatedTasks(successfulTaskIds);
          await this.notionAPI.statusCache.updateTasksInCache(database.id, updatedTasks);
          console.log(chalk.blue(`🔄 Updated ${successfulTaskIds.length} tasks in cache`));
        } catch (error) {
          // Fall back to full cache invalidation if targeted update fails
          await this.notionAPI.statusCache.invalidateTaskCache();
          console.log(chalk.blue('🔄 Cache refreshed'));
        }
      }
      
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to assign ${failed} tasks`));
        const failedResults = results.filter(r => !r.success);
        for (const result of failedResults) {
          console.log(chalk.red(`  - ${result.pageId}: ${result.error}`));
        }
      }
    } catch (error) {
      console.error(chalk.red('Batch assignment failed:'), error.message);
    }
  }
}
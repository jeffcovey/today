import inquirer from 'inquirer';
import chalk from 'chalk';

export class CLIInterface {
  constructor(notionAPI) {
    this.notionAPI = notionAPI;
  }

  async start() {
    console.log(chalk.blue.bold('\n🗄️  Notion Database Batch Editor\n'));

    // Step 1: Select database
    const database = await this.selectDatabase();
    if (!database) return;

    console.log(chalk.green(`\nSelected: ${database.title}`));

    // Step 2: Load database schema and items
    const [schema, items] = await Promise.all([
      this.notionAPI.getDatabaseSchema(database.id),
      this.notionAPI.getDatabaseItems(database.id)
    ]);

    if (items.length === 0) {
      console.log(chalk.yellow('This database has no items to edit.'));
      return;
    }

    console.log(chalk.blue(`\nFound ${items.length} items in the database`));

    // Step 3: Select items to edit
    const selectedItems = await this.selectItems(items);
    if (selectedItems.length === 0) return;

    console.log(chalk.green(`\nSelected ${selectedItems.length} items for editing`));

    // Step 4: Select properties to edit
    const editableProperties = this.getEditableProperties(schema.properties);
    if (editableProperties.length === 0) {
      console.log(chalk.yellow('No editable properties found in this database.'));
      return;
    }

    const propertiesToEdit = await this.selectProperties(editableProperties);
    if (propertiesToEdit.length === 0) return;

    // Step 5: Get new values for selected properties
    const newValues = await this.getNewValues(propertiesToEdit, schema.properties);

    // Step 6: Confirm and execute batch update
    await this.confirmAndExecute(selectedItems, newValues, propertiesToEdit);
  }

  async selectDatabase() {
    try {
      console.log(chalk.blue('Fetching your databases...'));
      const databases = await this.notionAPI.getDatabases();

      if (databases.length === 0) {
        console.log(chalk.yellow('No databases found. Make sure your integration has access to databases.'));
        return null;
      }

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

  async selectItems(items) {
    const { selectedItems } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedItems',
        message: 'Select items to edit (use spacebar to select, enter to confirm):',
        choices: items.map(item => ({
          name: `${item.title}`,
          value: item,
          checked: false
        })),
        pageSize: 15,
        validate: (input) => {
          if (input.length === 0) {
            return 'Please select at least one item';
          }
          return true;
        }
      }
    ]);

    return selectedItems;
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
    const { selectedProperties } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedProperties',
        message: 'Select properties to edit:',
        choices: editableProperties.map(prop => ({
          name: `${prop.name} (${prop.type})`,
          value: prop
        })),
        validate: (input) => {
          if (input.length === 0) {
            return 'Please select at least one property';
          }
          return true;
        }
      }
    ]);

    return selectedProperties;
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

    switch (property.type) {
      case 'title':
      case 'rich_text':
        const { textValue } = await inquirer.prompt([
          {
            type: 'input',
            name: 'textValue',
            message: `Enter new value for ${property.name}:`,
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
            message: `Enter new number for ${property.name}:`
          }
        ]);
        return { number: numberValue };

      case 'checkbox':
        const { checkboxValue } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'checkboxValue',
            message: `Set ${property.name} to:`
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
            message: `Enter new ${property.type} for ${property.name}:`
          }
        ]);
        return { [property.type]: stringValue };

      case 'date':
        const { dateValue } = await inquirer.prompt([
          {
            type: 'input',
            name: 'dateValue',
            message: `Enter new date for ${property.name} (YYYY-MM-DD):`,
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

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.yellow('Proceed with batch update?'),
        default: false
      }
    ]);

    if (!confirm) {
      console.log(chalk.blue('Operation cancelled.'));
      return;
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
}
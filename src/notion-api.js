import { Client } from '@notionhq/client';

export class NotionAPI {
  constructor(token) {
    this.notion = new Client({ auth: token });
  }

  async getDatabases() {
    try {
      const response = await this.notion.search({
        filter: {
          property: 'object',
          value: 'database'
        }
      });
      
      return response.results.map(db => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || 'Untitled Database',
        url: db.url
      }));
    } catch (error) {
      throw new Error(`Failed to fetch databases: ${error.message}`);
    }
  }

  async getDatabaseItems(databaseId, pageSize = 100) {
    try {
      const response = await this.notion.databases.query({
        database_id: databaseId,
        page_size: pageSize
      });

      return response.results.map(page => ({
        id: page.id,
        title: this.extractTitle(page),
        properties: page.properties,
        url: page.url
      }));
    } catch (error) {
      throw new Error(`Failed to fetch database items: ${error.message}`);
    }
  }

  async getDatabaseSchema(databaseId) {
    try {
      const database = await this.notion.databases.retrieve({
        database_id: databaseId
      });

      const properties = {};
      for (const [key, value] of Object.entries(database.properties)) {
        properties[key] = {
          id: value.id,
          type: value.type,
          name: key
        };
      }

      return {
        id: database.id,
        title: database.title?.[0]?.plain_text || 'Untitled Database',
        properties
      };
    } catch (error) {
      throw new Error(`Failed to fetch database schema: ${error.message}`);
    }
  }

  async updatePageProperties(pageId, properties) {
    try {
      await this.notion.pages.update({
        page_id: pageId,
        properties
      });
      return true;
    } catch (error) {
      throw new Error(`Failed to update page ${pageId}: ${error.message}`);
    }
  }

  async batchUpdatePages(updates) {
    const results = [];
    for (const update of updates) {
      try {
        await this.updatePageProperties(update.pageId, update.properties);
        results.push({ pageId: update.pageId, success: true });
      } catch (error) {
        results.push({ 
          pageId: update.pageId, 
          success: false, 
          error: error.message 
        });
      }
    }
    return results;
  }

  extractTitle(page) {
    // Try to find a title property
    for (const [key, value] of Object.entries(page.properties)) {
      if (value.type === 'title' && value.title?.[0]?.plain_text) {
        return value.title[0].plain_text;
      }
    }
    
    // Fallback to any rich_text property
    for (const [key, value] of Object.entries(page.properties)) {
      if (value.type === 'rich_text' && value.rich_text?.[0]?.plain_text) {
        return value.rich_text[0].plain_text;
      }
    }
    
    return 'Untitled';
  }

  formatPropertyValue(property) {
    switch (property.type) {
      case 'title':
      case 'rich_text':
        return property[property.type]?.[0]?.plain_text || '';
      case 'number':
        return property.number || '';
      case 'select':
        return property.select?.name || '';
      case 'multi_select':
        return property.multi_select?.map(s => s.name).join(', ') || '';
      case 'date':
        return property.date?.start || '';
      case 'checkbox':
        return property.checkbox ? 'Yes' : 'No';
      case 'url':
        return property.url || '';
      case 'email':
        return property.email || '';
      case 'phone_number':
        return property.phone_number || '';
      default:
        return '';
    }
  }
}
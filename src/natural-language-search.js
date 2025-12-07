import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { ClaudeCLIAdapter } from './claude-cli-adapter.js';

export class NaturalLanguageSearch {
  constructor() {
    // Check for TODAY_ANTHROPIC_KEY
    const anthropicKey = process.env.TODAY_ANTHROPIC_KEY;
    if (anthropicKey) {
      this.client = new Anthropic({ apiKey: anthropicKey });
      this.searchMethod = 'anthropic';
      this.cliAdapter = null;
    } else {
      this.client = null;
      this.searchMethod = 'claude-cli';
      this.cliAdapter = new ClaudeCLIAdapter();
    }
  }

  // Generic method to ask Claude a question
  async askClaude(systemPrompt, userQuery, options = {}) {
    // Use CLI adapter if no API client
    if (this.cliAdapter) {
      return await this.cliAdapter.askClaude(systemPrompt, userQuery, options);
    }

    if (!this.client) {
      throw new Error('Claude API not configured');
    }

    try {
      const response = await this.client.messages.create({
        model: options.model || 'claude-3-haiku-20240307',
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userQuery }
        ]
      });

      return response.content[0].text;
    } catch (error) {
      console.error('Claude API error:', error);
      throw error;
    }
  }

  // Enhanced method to filter data using Claude's understanding
  async filterWithClaude(items, query, itemType = 'emails') {
    // Use CLI adapter if available
    if (this.cliAdapter) {
      return await this.cliAdapter.filterWithClaude(items, query, itemType);
    }

    if (!this.client) {
      throw new Error('Claude API not configured');
    }

    const systemPrompt = `You are a smart filter for ${itemType}. The user will provide a natural language query and a list of items in JSON format. 
    
Your response must be ONLY a valid JSON array containing the items that match the user's query. No other text, explanation, or formatting.

Use your understanding of natural language to interpret requests like:
- "personal emails" (exclude newsletters, marketing, automated messages)
- "important tasks" (high priority or urgent items)
- "work stuff" (work-related items)
- "from last week" (date filtering)
- "unread" (status filtering)

For "personal" emails, ONLY include emails from real people. Exclude ALL:
- Marketing emails (sale, offer, deals, promo, discount, shop, store)
- Newsletters (newsletter, marketing, updates, news, digest)
- Automated messages (noreply, no-reply, alerts, notifications, automated)
- Service/system emails ([MISSING], [REPORTING], monitoring, status)
- Company broadcasts (not addressed to you personally)
- Anything that looks automated or mass-sent

Personal means: from an actual human writing to you specifically

Return ONLY the JSON array. Example: [{"id": 1, ...}, {"id": 2, ...}]`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 4000,
        temperature: 0,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Query: "${query}"\n\nItems to filter:\n${JSON.stringify(items, null, 2)}`
          }
        ]
      });

      const responseText = response.content[0].text.trim();

      // Try to extract JSON even if there's extra text
      let jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error('Claude response was not JSON:', responseText.substring(0, 100) + '...');
        return items;
      }

      const filteredItems = JSON.parse(jsonMatch[0]);
      return Array.isArray(filteredItems) ? filteredItems : [];
    } catch (error) {
      console.error('Claude filtering error:', error.message);
      // Fall back to returning all items
      return items;
    }
  }

  // Search database items using available AI
  async searchItems(items, query, databaseType = 'tasks') {
    if (this.searchMethod === 'anthropic' && this.client) {
      return this.searchWithClaude(items, query, databaseType);
    } else {
      // Try Ollama first, fall back to basic search
      try {
        return await this.searchWithOllama(items, query, databaseType);
      } catch (error) {
        console.log(chalk.yellow('AI search not available, using basic search'));
        return this.basicSearch(items, query, databaseType);
      }
    }
  }

  // Get a display title for any database item
  getItemTitle(item) {
    // Try various common title property names
    const titleProps = ['Name', 'Title', 'Task', 'Project', 'Item', 'Subject', 'Topic'];

    for (const prop of titleProps) {
      if (item.properties?.[prop]) {
        const propData = item.properties[prop];
        // Handle different property types
        if (propData.title?.[0]?.text?.content) {
          return propData.title[0].text.content;
        }
        if (propData.rich_text?.[0]?.text?.content) {
          return propData.rich_text[0].text.content;
        }
      }
    }

    // Fallback to direct title property or 'Untitled'
    return item.title || 'Untitled';
  }

  // Extract key properties from any database item
  getItemProperties(item, databaseType) {
    const props = {};

    // Common properties across databases
    props.title = this.getItemTitle(item);

    // Database-specific property extraction
    if (databaseType === 'tasks') {
      props.hasProject = item.properties?.['Projects (DB)']?.relation?.[0] ? 'Y' : 'N';
      props.hasDate = item.properties?.['Do Date']?.date?.start ? 'Y' : 'N';
      props.stage = item.properties?.Stage?.select?.name || 'None';
      props.priority = item.properties?.Priority?.select?.name || 'None';
    } else if (databaseType === 'projects') {
      props.status = item.properties?.Status?.select?.name || 'None';
      props.category = item.properties?.Category?.select?.name || 'None';
      props.hasDeadline = item.properties?.Deadline?.date?.start ? 'Y' : 'N';
    } else if (databaseType === 'contacts') {
      props.company = item.properties?.Company?.rich_text?.[0]?.text?.content || 'None';
      props.lastContact = item.properties?.['Last Contact']?.date?.start || 'Never';
      props.relationship = item.properties?.Relationship?.select?.name || 'None';
    } else {
      // Generic properties for unknown databases
      // Look for any date, select, or relation properties
      for (const [key, value] of Object.entries(item.properties || {})) {
        if (value.date?.start) props.hasDate = 'Y';
        if (value.select?.name) props[key] = value.select.name;
        if (value.relation?.length > 0) props[key] = 'Y';
      }
    }

    return props;
  }

  // Search using local Ollama - now handles ANY database type
  async searchWithOllama(items, query, databaseType = 'tasks') {
    // Check if Ollama is running
    try {
      const testResponse = await fetch('http://localhost:11434/api/tags');
      if (!testResponse.ok) throw new Error('Ollama not running');
    } catch (error) {
      throw new Error('Ollama service not available');
    }

    const maxItems = 150;
    const itemsToSearch = items.slice(0, maxItems);

    // Prepare item summaries based on database type
    const itemSummaries = itemsToSearch.map((item, index) => {
      const props = this.getItemProperties(item, databaseType);

      // Create a summary line based on database type
      if (databaseType === 'tasks') {
        return `${index}|${props.title}|P:${props.hasProject}|D:${props.hasDate}|S:${props.stage}`;
      } else if (databaseType === 'projects') {
        return `${index}|${props.title}|Status:${props.status}|Cat:${props.category}|DL:${props.hasDeadline}`;
      } else if (databaseType === 'contacts') {
        return `${index}|${props.title}|Co:${props.company}|Last:${props.lastContact}|Rel:${props.relationship}`;
      } else {
        // Generic format
        const propsStr = Object.entries(props)
          .filter(([k]) => k !== 'title')
          .map(([k, v]) => `${k}:${v}`)
          .join('|');
        return `${index}|${props.title}|${propsStr}`;
      }
    }).join('\n');

    // Flexible prompt that adapts to database type
    const prompt = `You are searching through a ${databaseType} database. The user's query might be:
- Looking for specific ${databaseType} (direct search)
- Asking questions (e.g., "what should I focus on?", "what's most important?")
- Making complex requests (e.g., "things I've been neglecting", "quick wins")
- Expressing needs/feelings (e.g., "I'm overwhelmed", "I need inspiration")

User query: "${query}"

${databaseType.charAt(0).toUpperCase() + databaseType.slice(1)} items:
${itemSummaries}

Based on the query, return the indices of the 10 most relevant items. Consider:
- The query intent and context
- Item titles and their meaning
- All available properties and their values
- The type of database and what the user might be looking for

Return ONLY comma-separated numbers, like: 0,5,12,3,8`;

    try {
      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'tinyllama',
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.3,
            top_p: 0.9,
            num_predict: 100,
            num_ctx: 2048,  // Reduce context to save memory
            num_batch: 128   // Smaller batch size
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(chalk.red('Ollama API error:'), errorText);
        throw new Error('Ollama request failed');
      }

      const result = await response.json();
      const content = result.response;

      // Parse the response
      const indices = content.match(/\d+/g)?.map(n => parseInt(n)) || [];

      // Return the selected items
      const results = indices
        .filter(i => i >= 0 && i < itemsToSearch.length)
        .map(i => itemsToSearch[i]);

      return {
        results: results.slice(0, 10),
        totalFound: results.length,
        searchMethod: 'ollama',
        databaseType
      };
    } catch (error) {
      console.error(chalk.red('Ollama error:'), error.message);
      throw error;
    }
  }

  // Search using Claude API - database-agnostic
  async searchWithClaude(items, query, databaseType = 'tasks') {
    try {
      const maxItems = 200;
      const itemsToSearch = items.slice(0, maxItems);

      // Prepare item summaries
      const itemSummaries = itemsToSearch.map((item, index) => {
        const props = this.getItemProperties(item, databaseType);
        const propsStr = Object.entries(props)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        return `${index}: ${propsStr}`;
      }).join('\n');

      // Ask Claude to analyze the query
      const response = await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `I have a ${databaseType} database and need help finding relevant items based on this query: "${query}"

This could be:
- A direct search
- A question about what to focus on
- A request for suggestions or recommendations
- A complex query about patterns or relationships

Here are the ${databaseType} items:
${itemSummaries}

Please analyze the query intent and return a JSON array of the 10 most relevant item indices. Consider all properties and their values in context of what the user is looking for.

Return ONLY a JSON array of numbers, like: [0, 5, 12, 3]`
        }]
      });

      const content = response.content[0].text;

      // Extract just the JSON array from the response
      // Claude sometimes adds explanation text
      let indices;
      try {
        // First try direct parse
        indices = JSON.parse(content);
      } catch (e) {
        // If that fails, look for a JSON array in the text
        const jsonMatch = content.match(/\[[\d,\s]+\]/);
        if (!jsonMatch) {
          console.error(chalk.red('Could not parse Claude response:'), content);
          throw new Error('Invalid response format');
        }
        indices = JSON.parse(jsonMatch[0]);
      }

      const results = indices
        .filter(i => i >= 0 && i < itemsToSearch.length)
        .map(i => itemsToSearch[i]);

      return {
        results: results.slice(0, 10),
        totalFound: results.length,
        searchMethod: 'claude',
        databaseType
      };
    } catch (error) {
      console.error(chalk.red('Claude API error:'), error.message);
      console.log(chalk.yellow('Falling back to basic search'));
      return this.basicSearch(items, query, databaseType);
    }
  }

  // Basic fallback search - database-agnostic
  basicSearch(items, query, databaseType = 'tasks') {
    const lowerQuery = query.toLowerCase();
    const words = lowerQuery.split(/\s+/).filter(w => w.length > 2);

    // Enhanced keyword mappings for common queries
    const conceptMappings = {
      health: ['health', 'doctor', 'medical', 'vaccine', 'wellness', 'exercise', 'fitness', 'diet', 'nutrition', 'medicine', 'checkup', 'appointment', 'therapy', 'mental', 'physical', 'shingles', 'vitamin'],
      productivity: ['productive', 'important', 'urgent', 'priority', 'focus', 'accomplish', 'complete', 'finish'],
      social: ['friend', 'contact', 'call', 'meet', 'visit', 'email', 'message', 'connect', 'relationship'],
      maintenance: ['maintenance', 'repair', 'fix', 'clean', 'organize', 'update', 'check', 'review'],
      finance: ['money', 'bill', 'pay', 'financial', 'budget', 'expense', 'cost', 'invoice', 'tax']
    };

    // Expand search terms based on concepts
    const expandedTerms = new Set(words);
    for (const [concept, keywords] of Object.entries(conceptMappings)) {
      if (words.some(w => concept.includes(w) || keywords.some(kw => kw.includes(w)))) {
        keywords.forEach(kw => expandedTerms.add(kw));
      }
    }

    // Score each item
    const scoredItems = items.map(item => {
      const title = this.getItemTitle(item).toLowerCase();
      let score = 0;

      // Title matching
      if (title.includes(lowerQuery)) {
        score += 10;
      }

      // Check expanded terms
      for (const term of expandedTerms) {
        if (title.includes(term)) {
          score += 3;
        }
      }

      // Original word matching
      for (const word of words) {
        if (title.includes(word)) {
          score += 2;
        }
      }

      // Check all text properties for matches
      for (const prop of Object.values(item.properties || {})) {
        const text = this.getPropertyText(prop).toLowerCase();
        for (const term of expandedTerms) {
          if (text.includes(term)) {
            score += 1;
          }
        }
      }

      return { item, score };
    });

    // Return items with any match
    const results = scoredItems
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.item);

    // If no matches, return random sample
    if (results.length === 0 && items.length > 0) {
      console.log(chalk.yellow('No keyword matches found, returning random items'));
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      return {
        results: shuffled.slice(0, 10),
        totalFound: 10,
        searchMethod: 'random',
        databaseType
      };
    }

    return {
      results: results.slice(0, 10),
      totalFound: results.length,
      searchMethod: 'basic',
      databaseType
    };
  }

  // Helper to extract text from any property type
  getPropertyText(prop) {
    if (!prop) return '';

    // Title/Rich text
    if (prop.title?.[0]?.text?.content) return prop.title[0].text.content;
    if (prop.rich_text?.[0]?.text?.content) return prop.rich_text[0].text.content;

    // Select/Multi-select
    if (prop.select?.name) return prop.select.name;
    if (prop.multi_select) return prop.multi_select.map(s => s.name).join(' ');

    // Other types
    if (prop.url) return prop.url;
    if (prop.email) return prop.email;
    if (prop.phone_number) return prop.phone_number;
    if (prop.number !== undefined) return String(prop.number);
    if (prop.checkbox !== undefined) return prop.checkbox ? 'yes' : 'no';

    return '';
  }

  // Backward compatibility
  async searchTasks(tasks, query) {
    return this.searchItems(tasks, query, 'tasks');
  }
}
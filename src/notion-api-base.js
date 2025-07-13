import { Client } from '@notionhq/client';
import chalk from 'chalk';

export class NotionAPIBase {
  constructor(apiKey) {
    this.notion = new Client({ auth: apiKey });
  }

  /**
   * Core method for querying databases with automatic pagination, caching, and error handling
   * @param {Object} options - Query options
   * @param {string} options.databaseId - Database ID to query
   * @param {string} options.cacheKey - Key for caching (e.g., 'tasks', 'projects', 'doDateTasks')
   * @param {Function} options.getCacheData - Function to get cached data
   * @param {Function} options.setCacheData - Function to set cache data
   * @param {Function} options.isValidCache - Function to check if cache is valid
   * @param {Object} options.filter - Notion API filter object
   * @param {Array} options.sorts - Notion API sorts array
   * @param {number} options.pageSize - Page size for API requests (max 100)
   * @param {boolean} options.fetchAll - Whether to fetch all pages or just one
   * @param {Function} options.mapResult - Function to map Notion page to internal format
   * @param {boolean} options.useCache - Whether to use caching (default true)
   * @returns {Promise<Array>} Array of mapped results
   */
  async queryDatabase(options) {
    const {
      databaseId,
      cacheKey,
      getCacheData,
      setCacheData,
      isValidCache,
      filter,
      sorts,
      pageSize = 100,
      fetchAll = true,
      mapResult,
      useCache = true,
      logPrefix = '📋'
    } = options;

    try {
      // Step 1: Check cache if enabled
      if (useCache && getCacheData && isValidCache) {
        try {
          const database = await this.notion.databases.retrieve({ database_id: databaseId });
          const currentLastEditedTime = database.last_edited_time;

          if (await isValidCache(databaseId, currentLastEditedTime)) {
            const cached = await getCacheData(databaseId);
            if (cached && cached[cacheKey]) {
              console.log(`${logPrefix} Using cached ${cacheKey} data`);
              return cached[cacheKey];
            }
          }
        } catch (cacheError) {
          console.warn(`Cache check failed for ${cacheKey}, proceeding without cache:`, cacheError.message);
        }
      }

      // Step 2: Build query parameters
      const queryParams = {
        database_id: databaseId,
        page_size: Math.min(pageSize, 100) // Notion API max is 100
      };

      if (filter) queryParams.filter = filter;
      if (sorts) queryParams.sorts = sorts;

      // Step 3: Execute query with pagination
      if (logPrefix) {
        console.log(`${logPrefix} Fetching ${cacheKey} from Notion API...`);
      }
      let allResults = [];
      let hasMore = true;
      let nextCursor = undefined;

      while (hasMore && (fetchAll || allResults.length < pageSize)) {
        const currentQuery = {
          ...queryParams,
          ...(nextCursor && { start_cursor: nextCursor })
        };

        const response = await this.notion.databases.query(currentQuery);
        
        allResults = allResults.concat(response.results);
        hasMore = response.has_more;
        nextCursor = response.next_cursor;

        // If not fetching all and we have enough results, break
        if (!fetchAll && allResults.length >= pageSize) {
          allResults = allResults.slice(0, pageSize);
          break;
        }
      }

      // Step 4: Map results to internal format
      const mappedResults = mapResult ? allResults.map(mapResult) : allResults;

      // Step 5: Update cache if enabled
      if (useCache && setCacheData) {
        try {
          const database = await this.notion.databases.retrieve({ database_id: databaseId });
          await setCacheData(databaseId, mappedResults, database.last_edited_time, cacheKey);
        } catch (cacheError) {
          console.warn(`Failed to update cache for ${cacheKey}:`, cacheError.message);
        }
      }

      return mappedResults;
    } catch (error) {
      console.error(chalk.red(`Failed to query database for ${cacheKey}:`), error.message);
      throw error;
    }
  }

  /**
   * Fetch only newer items than what's in cache (for incremental updates)
   * @param {Object} options - Similar to queryDatabase but with lastSyncTime
   * @param {string} options.lastSyncTime - ISO timestamp of last sync
   */
  async queryDatabaseIncremental(options) {
    const { lastSyncTime, filter, ...rest } = options;

    // Add last_edited_time filter to existing filters
    const incrementalFilter = {
      and: [
        ...(filter?.and || (filter ? [filter] : [])),
        {
          timestamp: 'last_edited_time',
          last_edited_time: {
            after: lastSyncTime
          }
        }
      ]
    };

    return this.queryDatabase({
      ...rest,
      filter: incrementalFilter,
      useCache: false // Don't use cache for incremental updates
    });
  }

  /**
   * Standard page mapping function
   */
  mapPage(page) {
    return {
      id: page.id,
      title: this.extractTitle(page),
      properties: page.properties,
      url: page.url,
      created_time: page.created_time,
      last_edited_time: page.last_edited_time
    };
  }

  extractTitle(page) {
    // Try to find a title property
    for (const value of Object.values(page.properties)) {
      if (value.type === 'title' && value.title?.[0]?.plain_text) {
        return value.title[0].plain_text;
      }
    }
    
    // Fallback to any rich_text property
    for (const value of Object.values(page.properties)) {
      if (value.type === 'rich_text' && value.rich_text?.[0]?.plain_text) {
        return value.rich_text[0].plain_text;
      }
    }
    
    return 'Untitled';
  }

  /**
   * Batch update pages with rate limiting and error handling
   */
  async batchUpdatePages(updates, options = {}) {
    const { concurrency = 5, delayMs = 100, onProgress, showProgress } = options;
    const results = [];
    const totalBatches = Math.ceil(updates.length / concurrency);
    
    // Process in chunks for better rate limiting
    for (let i = 0; i < updates.length; i += concurrency) {
      const chunk = updates.slice(i, i + concurrency);
      const batchNumber = Math.floor(i / concurrency) + 1;
      
      if (showProgress) {
        const processed = Math.min(i + concurrency, updates.length);
        console.log(chalk.gray(`  Processing batch ${batchNumber}/${totalBatches} (${processed}/${updates.length} items)...`));
      }
      
      const chunkPromises = chunk.map(async (update) => {
        try {
          // Use updatePageProperties if available (for subclasses), otherwise direct API call
          if (this.updatePageProperties) {
            const response = await this.updatePageProperties(update.pageId, update.properties);
            return { pageId: update.pageId, success: true, response };
          } else {
            await this.notion.pages.update({
              page_id: update.pageId,
              properties: update.properties
            });
            return { pageId: update.pageId, success: true };
          }
        } catch (error) {
          return { 
            pageId: update.pageId, 
            success: false, 
            error: error.message 
          };
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);

      if (onProgress) {
        onProgress(results.length, updates.length);
      }

      // Add delay between chunks to avoid rate limiting
      if (i + concurrency < updates.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }
}
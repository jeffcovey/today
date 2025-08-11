#!/usr/bin/env node

import { execSync } from 'child_process';
import chalk from 'chalk';

export class LocalLLM {
  constructor() {
    this.provider = null;
    this.model = null;
    this.initialized = false;
    this.detectAvailableProviders();
  }

  detectAvailableProviders() {
    // Check for Ollama
    try {
      execSync('which ollama', { stdio: 'ignore' });
      this.provider = 'ollama';
      
      // Ensure Ollama server is running
      this.ensureOllamaRunning();
      
      // Check which models are available
      const models = execSync('ollama list 2>/dev/null', { encoding: 'utf-8' })
        .split('\n')
        .filter(line => line.trim())
        .map(line => line.split(/\s+/)[0]);
      
      // Prefer smaller, faster models for simple tasks
      const preferredModels = ['phi3', 'tinyllama', 'mistral', 'llama3', 'gemma'];
      for (const preferred of preferredModels) {
        if (models.some(m => m.includes(preferred))) {
          this.model = models.find(m => m.includes(preferred));
          break;
        }
      }
      
      if (!this.model && models.length > 1) {
        // Skip the header line and pick first available model
        this.model = models[1];
      }
      
      if (this.model) {
        console.log(chalk.green(`✓ Using Ollama with model: ${this.model}`));
        this.initialized = true;
      }
    } catch (e) {
      // Ollama not available
    }

    // If no local LLM available, provide instructions
    if (!this.initialized) {
      console.log(chalk.yellow('No local LLM found. To enable free AI features:'));
      console.log(chalk.gray('  1. Install Ollama: curl -fsSL https://ollama.com/install.sh | sh'));
      console.log(chalk.gray('  2. Pull a model: ollama pull phi3'));
    }
  }

  ensureOllamaRunning() {
    try {
      // Check if Ollama server is already running
      execSync('curl -s http://localhost:11434/api/tags > /dev/null 2>&1', { stdio: 'ignore' });
      // Server is running
      return true;
    } catch (e) {
      // Server not running, try to start it
      try {
        console.log(chalk.gray('Starting Ollama server...'));
        // Start ollama serve in background, redirect output to avoid noise
        execSync('ollama serve > /dev/null 2>&1 &', { shell: '/bin/bash' });
        // Give it a moment to start
        execSync('sleep 2');
        
        // Verify it started
        try {
          execSync('curl -s http://localhost:11434/api/tags > /dev/null 2>&1', { stdio: 'ignore' });
          console.log(chalk.green('✓ Ollama server started'));
          return true;
        } catch (verifyError) {
          console.log(chalk.yellow('⚠ Ollama server may need manual start: ollama serve'));
          return false;
        }
      } catch (startError) {
        console.log(chalk.yellow('⚠ Could not auto-start Ollama server'));
        return false;
      }
    }
  }

  async isAvailable() {
    if (this.initialized && this.provider === 'ollama') {
      // Double-check that Ollama is still running
      this.ensureOllamaRunning();
    }
    return this.initialized;
  }

  async prompt(systemPrompt, userPrompt, options = {}) {
    if (!this.initialized) {
      throw new Error('No local LLM available');
    }

    // Ensure server is running before making request
    if (this.provider === 'ollama') {
      this.ensureOllamaRunning();
    }

    const maxTokens = options.maxTokens || 500;
    const temperature = options.temperature || 0.7;
    
    try {
      // Create a combined prompt for Ollama
      const fullPrompt = `${systemPrompt}\n\nUser: ${userPrompt}\n\nAssistant:`;
      
      // Use Ollama's CLI interface
      const response = execSync(
        `echo '${fullPrompt.replace(/'/g, "'\\''").replace(/\n/g, '\\n')}' | ollama run ${this.model} --verbose=false 2>/dev/null`,
        { 
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          timeout: 30000 // 30 second timeout
        }
      );
      
      return response.trim();
    } catch (error) {
      console.error('Local LLM error:', error.message);
      throw error;
    }
  }

  // Specific method for generating daily recommendations
  async generateDailyRecommendations(summary) {
    const systemPrompt = `You are a helpful assistant that generates 3-5 actionable daily recommendations based on a task summary.
    Respond with ONLY a JSON array of recommendation strings, no other text.`;
    
    const userPrompt = `Based on this summary, provide 3-5 specific recommendations:
    - ${summary.concerns_count} concerns noted
    - ${summary.overdue_count} overdue tasks  
    - ${summary.urgent_count} urgent tasks
    - ${summary.email_count} important emails
    - ${summary.contacts} people to contact`;
    
    try {
      const response = await this.prompt(systemPrompt, userPrompt, { maxTokens: 300 });
      
      // Try to extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback: split by newlines if not JSON
      return response.split('\n')
        .filter(line => line.trim().length > 10)
        .map(line => line.replace(/^[-*•]\s*/, '').trim())
        .slice(0, 5);
    } catch (error) {
      // Return basic recommendations on error
      return [
        'Review and address overdue tasks',
        'Respond to important emails',
        'Check calendar for upcoming events',
        'Review noted concerns and create action items',
        'Plan focus time for high-priority work'
      ];
    }
  }

  // Method for simple intent classification
  async classifyIntent(query) {
    const systemPrompt = `Classify the user's intent into one of these categories: search, count, action, info.
    Respond with ONLY the category name, nothing else.`;
    
    try {
      const response = await this.prompt(systemPrompt, query, { maxTokens: 10 });
      const intent = response.toLowerCase().trim();
      
      if (['search', 'count', 'action', 'info'].includes(intent)) {
        return intent;
      }
      
      // Fallback to keyword matching
      return this.classifyIntentFallback(query);
    } catch (error) {
      return this.classifyIntentFallback(query);
    }
  }

  // Fallback rule-based intent classification
  classifyIntentFallback(query) {
    const q = query.toLowerCase();
    
    if (q.includes('how many') || q.includes('count') || q.includes('number of')) {
      return 'count';
    }
    if (q.includes('show') || q.includes('find') || q.includes('search') || q.includes('list')) {
      return 'search';
    }
    if (q.includes('delete') || q.includes('archive') || q.includes('mark') || q.includes('move')) {
      return 'action';
    }
    
    return 'info';
  }

  // Extract search keywords
  async extractKeywords(query, context = 'emails') {
    const systemPrompt = `Extract key search terms from the user query about ${context}.
    Return ONLY a JSON object with fields like: {from, subject, date, keywords}`;
    
    try {
      const response = await this.prompt(systemPrompt, query, { maxTokens: 100 });
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      // Fallback to simple keyword extraction
    }
    
    // Simple fallback extraction
    const keywords = query.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3 && !['from', 'about', 'with', 'have', 'that', 'this'].includes(word));
    
    return { keywords };
  }
}

// Export singleton instance
export const localLLM = new LocalLLM();
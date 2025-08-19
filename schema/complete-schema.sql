CREATE TABLE cache_metadata (                                                                     
        database_id TEXT PRIMARY KEY,                                                             
        cache_type TEXT NOT NULL,                                                                 
        last_edited_time TEXT NOT NULL,                                                           
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE calendar_events (                                                                    
    id TEXT PRIMARY KEY,                                                                          
    source TEXT NOT NULL,                                                                         
    calendar_name TEXT,                                                                           
    title TEXT NOT NULL,                                                                          
    start_date DATETIME NOT NULL,                                                                 
    end_date DATETIME NOT NULL,                                                                   
    start_timezone TEXT,                                                                          
    end_timezone TEXT,                                                                            
    location TEXT,                                                                                
    description TEXT,                                                                             
    all_day BOOLEAN DEFAULT 0,                                                                    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_calendar_events_start_date ON calendar_events(start_date);                       
CREATE INDEX idx_calendar_events_end_date ON calendar_events(end_date);                           
CREATE INDEX idx_calendar_events_title ON calendar_events(title);                                 
CREATE INDEX idx_calendar_events_source ON calendar_events(source);                               
CREATE TABLE contact_addresses (                                                                  
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    contact_id TEXT NOT NULL,                                                                     
    po_box TEXT,                                                                                  
    extended TEXT,                                                                                
    street TEXT,                                                                                  
    city TEXT,                                                                                    
    region TEXT,                                                                                  
    postal_code TEXT,                                                                             
    country TEXT,                                                                                 
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE                            
  );                                                                                              
CREATE INDEX idx_contact_addresses_contact_id ON contact_addresses(contact_id);                   
CREATE TABLE contact_emails (                                                                     
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    contact_id TEXT NOT NULL,                                                                     
    email TEXT NOT NULL,                                                                          
    is_primary BOOLEAN DEFAULT 0,                                                                 
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE                            
  );                                                                                              
CREATE INDEX idx_contact_emails_email ON contact_emails(email);                                   
CREATE INDEX idx_contact_emails_contact_id ON contact_emails(contact_id);                         
CREATE TABLE contact_phones (                                                                     
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    contact_id TEXT NOT NULL,                                                                     
    phone TEXT NOT NULL,                                                                          
    is_primary BOOLEAN DEFAULT 0,                                                                 
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE                            
  );                                                                                              
CREATE INDEX idx_contact_phones_contact_id ON contact_phones(contact_id);                         
CREATE TABLE contacts (                                                                           
    id TEXT PRIMARY KEY,                                                                          
    first_name TEXT,                                                                              
    last_name TEXT,                                                                               
    full_name TEXT,                                                                               
    organization TEXT,                                                                            
    birthday TEXT,                                                                                
    url TEXT,                                                                                     
    etag TEXT,                                                                                    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_contacts_full_name ON contacts(full_name);                                       
CREATE INDEX idx_contacts_last_name ON contacts(last_name);                                       
CREATE TABLE database_cache (                                                                     
        id TEXT PRIMARY KEY,                                                                      
        title TEXT NOT NULL,                                                                      
        url TEXT NOT NULL,                                                                        
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE email_entity_mentions (                                                              
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    email_id TEXT NOT NULL,                                                                       
    entity_type TEXT NOT NULL, -- 'contact', 'task', 'project', 'event'                           
    entity_id TEXT NOT NULL,                                                                      
    confidence REAL DEFAULT 1.0,                                                                  
    context TEXT,                                                                                 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_email_mentions_email ON email_entity_mentions(email_id);                         
CREATE INDEX idx_email_mentions_entity ON email_entity_mentions(entity_type, entity_id);          
CREATE TABLE emails (                                                                             
    id INTEGER PRIMARY KEY,                                                                       
    uid INTEGER,                                                                                  
    message_id TEXT,                                                                              
    from_address TEXT,                                                                            
    to_address TEXT,                                                                              
    subject TEXT,                                                                                 
    date DATETIME,                                                                                
    headers TEXT,                                                                                 
    text_content TEXT,                                                                            
    html_content TEXT,                                                                            
    attachments TEXT,                                                                             
    flags TEXT,                                                                                   
    size INTEGER,                                                                                 
    raw_source TEXT,                                                                              
    folder TEXT DEFAULT 'INBOX',                                                                  
    downloaded_at DATETIME DEFAULT CURRENT_TIMESTAMP                                              
);                                                                                                
CREATE TABLE event_attendees (                                                                    
    event_id TEXT NOT NULL,                                                                       
    contact_id TEXT,                                                                              
    email TEXT NOT NULL,                                                                          
    name TEXT,                                                                                    
    response_status TEXT,                                                                         
    is_organizer BOOLEAN DEFAULT 0,                                                               
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                
    PRIMARY KEY (event_id, email)                                                                 
  );                                                                                              
CREATE INDEX idx_event_attendees_event ON event_attendees(event_id);                              
CREATE INDEX idx_event_attendees_contact ON event_attendees(contact_id);                          
CREATE INDEX idx_event_attendees_email ON event_attendees(email);                                 
CREATE TABLE file_tracking (                                                                      
    file_path TEXT PRIMARY KEY,                                                                   
    last_modified DATETIME NOT NULL,                                                              
    file_type TEXT,                                                                               
    category TEXT,                                                                                
    size_bytes INTEGER,                                                                           
    hash TEXT,                                                                                    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_file_tracking_last_modified ON file_tracking(last_modified);                     
CREATE INDEX idx_file_tracking_category ON file_tracking(category);                               
CREATE INDEX idx_file_tracking_file_type ON file_tracking(file_type);                             
CREATE INDEX idx_file_tracking_path ON file_tracking(file_path);                                  
CREATE INDEX idx_file_tracking_modified ON file_tracking(last_modified);                          
CREATE TABLE markdown_sync (                                                                      
      file_path TEXT NOT NULL,                                                                    
      task_id TEXT NOT NULL,                                                                      
      line_number INTEGER,                                                                        
      last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,                                             
      PRIMARY KEY (file_path, task_id),                                                           
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE                                
    );                                                                                            
CREATE TABLE people_to_contact (                                                                  
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    summary_date DATE NOT NULL,                                                                   
    contact_id TEXT,                                                                              
    contact_name TEXT NOT NULL,                                                                   
    reason TEXT,                                                                                  
    urgency TEXT,                                                                                 
    last_contact_date DATE,                                                                       
    suggested_action TEXT,                                                                        
    completed BOOLEAN DEFAULT 0,                                                                  
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_people_to_contact_date ON people_to_contact(summary_date);                       
CREATE INDEX idx_people_to_contact_completed ON people_to_contact(completed);                     
CREATE INDEX idx_people_to_contact_contact_id ON people_to_contact(contact_id);                   
CREATE TABLE project_cache (                                                                      
        id TEXT PRIMARY KEY,                                                                      
        database_id TEXT NOT NULL,                                                                
        title TEXT NOT NULL,                                                                      
        url TEXT NOT NULL,                                                                        
        created_time TEXT NOT NULL,                                                               
        status TEXT,                                                                              
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE project_pillar_mapping (                                                             
        toggl_project_id TEXT PRIMARY KEY,                                                        
        notion_pillar_id TEXT,                                                                    
        project_name TEXT,                                                                        
        pillar_name TEXT,                                                                         
        updated_at INTEGER                                                                        
      );                                                                                          
CREATE TABLE project_topics (                                                                     
      project_id TEXT,                                                                            
      topic_id TEXT,                                                                              
      PRIMARY KEY (project_id, topic_id),                                                         
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,                         
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE                              
    );                                                                                            
CREATE INDEX idx_project_topics_project ON project_topics(project_id);                            
CREATE INDEX idx_project_topics_topic ON project_topics(topic_id);                                
CREATE TABLE projects (                                                                           
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),                                 
        name TEXT NOT NULL,                                                                       
        description TEXT,                                                                         
        status TEXT DEFAULT 'active',                                                             
        start_date DATE,                                                                          
        end_date DATE,                                                                            
        budget REAL,                                                                              
        file_path TEXT UNIQUE,                                                                    
        metadata TEXT,                                                                            
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                            
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                             
      );                                                                                          
CREATE TABLE status_groups_cache (                                                                
        database_id TEXT PRIMARY KEY,                                                             
        status_groups TEXT NOT NULL,                                                              
        last_edited_time TEXT NOT NULL,                                                           
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE streaks_data (                                                                       
        id TEXT PRIMARY KEY,                                                                      
        streak_name TEXT,                                                                         
        current_count INTEGER,                                                                    
        last_updated TEXT,                                                                        
        data_hash TEXT,                                                                           
        notion_page_id TEXT                                                                       
      );                                                                                          
CREATE TABLE summary_insights (                                                                   
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    summary_date DATE NOT NULL,                                                                   
    category TEXT NOT NULL,                                                                       
    insight TEXT NOT NULL,                                                                        
    priority INTEGER DEFAULT 0,                                                                   
    confidence REAL DEFAULT 0.0,                                                                  
    related_entity_type TEXT,                                                                     
    related_entity_id TEXT,                                                                       
    metadata TEXT, -- JSON for additional data                                                    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_summary_insights_date ON summary_insights(summary_date);                         
CREATE INDEX idx_summary_insights_category ON summary_insights(category);                         
CREATE INDEX idx_summary_insights_priority ON summary_insights(priority);                         
CREATE TABLE summary_meta (                                                                       
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    summary_date DATE NOT NULL,                                                                   
    last_updated DATETIME NOT NULL,                                                               
    version TEXT,                                                                                 
    update_count INTEGER DEFAULT 0,                                                               
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_summary_meta_date ON summary_meta(summary_date);                                 
CREATE TABLE summary_metrics (                                                                    
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    summary_date DATE NOT NULL,                                                                   
    metric_name TEXT NOT NULL,                                                                    
    metric_value REAL,                                                                            
    metric_unit TEXT,                                                                             
    category TEXT,                                                                                
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_summary_metrics_date ON summary_metrics(summary_date);                           
CREATE INDEX idx_summary_metrics_name ON summary_metrics(metric_name);                            
CREATE TABLE summary_recommendations (                                                            
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    summary_date DATE NOT NULL,                                                                   
    recommendation TEXT NOT NULL,                                                                 
    reason TEXT,                                                                                  
    priority INTEGER DEFAULT 0,                                                                   
    category TEXT,                                                                                
    status TEXT DEFAULT 'pending',                                                                
    related_task_id TEXT,                                                                         
    related_contact_id TEXT,                                                                      
    related_project_id TEXT,                                                                      
    metadata TEXT, -- JSON                                                                        
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_summary_recommendations_date ON summary_recommendations(summary_date);           
CREATE INDEX idx_summary_recommendations_status ON summary_recommendations(status);               
CREATE INDEX idx_summary_recommendations_priority ON summary_recommendations(priority);           
CREATE TABLE sync_log (                                                                           
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    timestamp DATETIME NOT NULL,                                                                  
    sync_type TEXT,                                                                               
    success BOOLEAN DEFAULT 0,                                                                    
    source_system TEXT,                                                                           
    target_system TEXT,                                                                           
    created_count INTEGER DEFAULT 0,                                                              
    updated_count INTEGER DEFAULT 0,                                                              
    deleted_count INTEGER DEFAULT 0,                                                              
    skipped_count INTEGER DEFAULT 0,                                                              
    error_count INTEGER DEFAULT 0,                                                                
    details TEXT, -- JSON string for full details                                                 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_sync_log_timestamp ON sync_log(timestamp);                                       
CREATE INDEX idx_sync_log_success ON sync_log(success);                                           
CREATE INDEX idx_sync_log_sync_type ON sync_log(sync_type);                                       
CREATE TABLE sync_metadata (key TEXT PRIMARY KEY, value TEXT);                                    
CREATE TABLE tag_cache (                                                                          
        id TEXT PRIMARY KEY,                                                                      
        database_id TEXT NOT NULL,                                                                
        title TEXT NOT NULL,                                                                      
        url TEXT NOT NULL,                                                                        
        created_time TEXT NOT NULL,                                                               
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE tags (                                                                               
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),                                 
        name TEXT UNIQUE NOT NULL,                                                                
        color TEXT                                                                                
      );                                                                                          
CREATE TABLE task_cache (                                                                         
        id TEXT PRIMARY KEY,                                                                      
        database_id TEXT NOT NULL,                                                                
        title TEXT NOT NULL,                                                                      
        properties TEXT NOT NULL,                                                                 
        url TEXT NOT NULL,                                                                        
        created_time TEXT NOT NULL,                                                               
        last_edited_time TEXT,                                                                    
        cached_at INTEGER NOT NULL                                                                
      );                                                                                          
CREATE TABLE task_completions (                                                                   
      id INTEGER PRIMARY KEY AUTOINCREMENT,                                                       
      task_id TEXT NOT NULL,                                                                      
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                            
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE                                
    );                                                                                            
CREATE INDEX idx_completions_task ON task_completions(task_id);                                   
CREATE INDEX idx_completions_date ON task_completions(completed_at);                              
CREATE TABLE task_event_links (                                                                   
    task_id TEXT NOT NULL,                                                                        
    event_id TEXT NOT NULL,                                                                       
    relationship_type TEXT, -- 'prep_for', 'follow_up', 'related'                                 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                
    PRIMARY KEY (task_id, event_id)                                                               
  );                                                                                              
CREATE INDEX idx_task_event_task ON task_event_links(task_id);                                    
CREATE INDEX idx_task_event_event ON task_event_links(event_id);                                  
CREATE TABLE task_relationships (                                                                 
    id INTEGER PRIMARY KEY AUTOINCREMENT,                                                         
    task_id TEXT NOT NULL,                                                                        
    related_task_id TEXT NOT NULL,                                                                
    relationship_type TEXT NOT NULL, -- 'blocks', 'blocked_by', 'parent', 'child', 'related'      
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                 
  );                                                                                              
CREATE INDEX idx_task_relationships_task ON task_relationships(task_id);                          
CREATE INDEX idx_task_relationships_related ON task_relationships(related_task_id);               
CREATE INDEX idx_task_relationships_type ON task_relationships(relationship_type);                
CREATE TABLE task_tags (                                                                          
        task_id TEXT,                                                                             
        tag_id TEXT,                                                                              
        PRIMARY KEY (task_id, tag_id),                                                            
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,                             
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE                                
      );                                                                                          
CREATE INDEX idx_task_tags_task ON task_tags(task_id);                                            
CREATE INDEX idx_task_tags_tag ON task_tags(tag_id);                                              
CREATE TABLE task_topics (                                                                        
      task_id TEXT,                                                                               
      topic_id TEXT,                                                                              
      PRIMARY KEY (task_id, topic_id),                                                            
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,                               
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE                              
    );                                                                                            
CREATE INDEX idx_task_topics_task ON task_topics(task_id);                                        
CREATE INDEX idx_task_topics_topic ON task_topics(topic_id);                                      
CREATE TABLE "tasks" (                                                                            
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),                                   
      title TEXT NOT NULL,                                                                        
      description TEXT,                                                                           
      content TEXT,                                                                               
      do_date DATE,                                                                               
      status TEXT DEFAULT '🎭 Stage',                                                             
      stage TEXT CHECK(stage IS NULL OR stage IN ('Front Stage', 'Back Stage', 'Off Stage')),     
      project_id TEXT,                                                                            
      repeat_interval INTEGER,                                                                    
      repeat_next_date DATE,                                                                      
      notion_id TEXT UNIQUE,                                                                      
      notion_url TEXT,                                                                            
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                              
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                              
      completed_at DATETIME,                                                                      
      FOREIGN KEY (project_id) REFERENCES projects(id)                                            
    );                                                                                            
CREATE INDEX idx_tasks_do_date ON tasks(do_date);                                                 
CREATE INDEX idx_tasks_status ON tasks(status);                                                   
CREATE INDEX idx_tasks_stage ON tasks(stage);                                                     
CREATE INDEX idx_tasks_project ON tasks(project_id);                                              
CREATE INDEX idx_tasks_notion_id ON tasks(notion_id);                                             
CREATE TRIGGER update_task_timestamp                                                              
      AFTER UPDATE ON tasks                                                                       
      BEGIN                                                                                       
        UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;                        
      END;                                                                                        
CREATE TABLE temporal_sync (                                                                      
        date TEXT PRIMARY KEY,                                                                    
        day_id TEXT,                                                                              
        week_id TEXT,                                                                             
        created_at INTEGER,                                                                       
        synced_at INTEGER,                                                                        
        week_start_date TEXT,                                                                     
        previous_day_id TEXT                                                                      
      );                                                                                          
CREATE TABLE time_entries_sync (                                                                  
        id TEXT PRIMARY KEY,                                                                      
        toggl_id TEXT,                                                                            
        focus_id TEXT,                                                                            
        processed_at INTEGER,                                                                     
        pillar_id TEXT,                                                                           
        duration INTEGER,                                                                         
        description TEXT,                                                                         
        project_name TEXT                                                                         
      );                                                                                          
CREATE TABLE todoist_sync_mapping (                                                               
        notion_id TEXT PRIMARY KEY,                                                               
        todoist_id TEXT NOT NULL,                                                                 
        last_synced INTEGER NOT NULL,                                                             
        sync_hash TEXT,                                                                           
        notion_last_edited TEXT,                                                                  
        todoist_last_edited TEXT,                                                                 
        notion_hash TEXT,                                                                         
        todoist_hash TEXT                                                                         
      );                                                                                          
CREATE TABLE topics (                                                                             
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),                                   
      name TEXT UNIQUE NOT NULL,                                                                  
      description TEXT,                                                                           
      notion_id TEXT UNIQUE,                                                                      
      color TEXT,                                                                                 
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                              
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                               
    );                                                                                            
CREATE INDEX idx_topics_notion ON topics(notion_id);                                              

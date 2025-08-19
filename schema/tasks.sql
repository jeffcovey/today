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

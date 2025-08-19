CREATE TABLE task_completions (                                        
      id INTEGER PRIMARY KEY AUTOINCREMENT,                            
      task_id TEXT NOT NULL,                                           
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,                 
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE     
    );                                                                 

CREATE TABLE markdown_sync (                                           
      file_path TEXT NOT NULL,                                         
      task_id TEXT NOT NULL,                                           
      line_number INTEGER,                                             
      last_synced DATETIME DEFAULT CURRENT_TIMESTAMP,                  
      PRIMARY KEY (file_path, task_id),                                
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE     
    );                                                                 

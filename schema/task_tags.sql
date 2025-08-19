CREATE TABLE task_tags (                                                  
        task_id TEXT,                                                     
        tag_id TEXT,                                                      
        PRIMARY KEY (task_id, tag_id),                                    
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,     
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE        
      );                                                                  

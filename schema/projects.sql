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

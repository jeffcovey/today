CREATE TABLE tags (                                                   
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),     
        name TEXT UNIQUE NOT NULL,                                    
        color TEXT                                                    
      );                                                              

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

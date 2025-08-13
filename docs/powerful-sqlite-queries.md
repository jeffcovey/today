# Powerful SQLite Queries - Today Database

Now that all data is in SQLite, here are powerful queries that were impossible with separate JSON files:

## 1. Cross-Entity Relationship Queries

### Find emails about upcoming calendar events
```sql
-- Find emails that might be about meetings in the next week
SELECT DISTINCT
  e.subject,
  e.from_address,
  c.title as event_title,
  datetime(c.start_date) as event_time
FROM emails e
CROSS JOIN calendar_events c
WHERE c.start_date BETWEEN datetime('now') AND datetime('now', '+7 days')
  AND (
    LOWER(e.subject) LIKE '%' || LOWER(SUBSTR(c.title, 1, 10)) || '%'
    OR LOWER(e.text_content) LIKE '%' || LOWER(SUBSTR(c.title, 1, 10)) || '%'
  )
ORDER BY c.start_date;
```

### Find overdue tasks mentioned in recent emails
```sql
SELECT 
  t.title as task,
  t.stage,
  e.subject as email_subject,
  e.from_address,
  DATE(e.date) as email_date
FROM task_cache t
JOIN emails e ON LOWER(e.text_content) LIKE '%' || LOWER(SUBSTR(t.title, 1, 20)) || '%'
WHERE t.due_date < DATE('now')
  AND t.stage != 'Done'
  AND e.date > datetime('now', '-7 days')
ORDER BY e.date DESC;
```

## 2. Activity Pattern Analysis

### Daily activity heatmap
```sql
SELECT 
  strftime('%H', datetime) as hour,
  strftime('%w', datetime) as day_of_week,
  COUNT(*) as activity_count
FROM (
  SELECT created_at as datetime FROM contacts
  UNION ALL
  SELECT date as datetime FROM emails
  UNION ALL
  SELECT start_date as datetime FROM calendar_events
  UNION ALL
  SELECT timestamp as datetime FROM sync_log
)
GROUP BY hour, day_of_week
ORDER BY day_of_week, hour;
```

### Communication patterns with top contacts
```sql
WITH email_stats AS (
  SELECT 
    from_address,
    COUNT(*) as email_count,
    MAX(date) as last_email,
    AVG(CASE WHEN has_been_replied_to = 1 THEN 1.0 ELSE 0.0 END) as reply_rate
  FROM emails
  WHERE date > datetime('now', '-30 days')
  GROUP BY from_address
)
SELECT 
  c.full_name,
  c.organization,
  es.email_count,
  DATE(es.last_email) as last_contact,
  ROUND(es.reply_rate * 100, 1) as reply_rate_pct,
  (julianday('now') - julianday(es.last_email)) as days_since_contact
FROM email_stats es
JOIN contact_emails ce ON es.from_address = ce.email
JOIN contacts c ON ce.contact_id = c.id
WHERE es.email_count > 2
ORDER BY es.email_count DESC
LIMIT 20;
```

## 3. Intelligent Recommendations

### People to reconnect with
```sql
-- Find contacts we haven't heard from in a while but used to email frequently
WITH contact_activity AS (
  SELECT 
    c.id,
    c.full_name,
    COUNT(DISTINCT e.id) as total_emails,
    MAX(e.date) as last_email,
    AVG(CASE 
      WHEN e.date > datetime('now', '-30 days') THEN 1.0 
      ELSE 0.0 
    END) as recent_activity_rate
  FROM contacts c
  JOIN contact_emails ce ON c.id = ce.contact_id
  JOIN emails e ON ce.email = e.from_address
  GROUP BY c.id
)
SELECT 
  full_name,
  total_emails,
  DATE(last_email) as last_contact,
  ROUND((julianday('now') - julianday(last_email)), 0) as days_silent,
  CASE 
    WHEN total_emails > 20 THEN 'Close contact'
    WHEN total_emails > 10 THEN 'Regular contact'
    ELSE 'Occasional contact'
  END as relationship_strength
FROM contact_activity
WHERE last_email < datetime('now', '-30 days')
  AND total_emails > 5
ORDER BY total_emails DESC, days_silent DESC
LIMIT 10;
```

### Meeting preparation checklist
```sql
-- For each upcoming meeting, show related tasks and recent emails
SELECT 
  c.title as meeting,
  datetime(c.start_date) as when_,
  c.location,
  GROUP_CONCAT(DISTINCT t.title) as related_tasks,
  COUNT(DISTINCT e.id) as recent_emails
FROM calendar_events c
LEFT JOIN task_cache t ON LOWER(t.title) LIKE '%' || LOWER(SUBSTR(c.title, 1, 15)) || '%'
LEFT JOIN emails e ON 
  LOWER(e.subject) LIKE '%' || LOWER(SUBSTR(c.title, 1, 15)) || '%'
  AND e.date > datetime('now', '-7 days')
WHERE c.start_date BETWEEN datetime('now') AND datetime('now', '+3 days')
GROUP BY c.id
ORDER BY c.start_date;
```

## 4. Data Quality & Insights

### File activity insights
```sql
-- Show which types of files are being updated most frequently
SELECT 
  category,
  file_type,
  COUNT(*) as file_count,
  AVG(julianday('now') - julianday(last_modified)) as avg_age_days,
  MIN(last_modified) as oldest_update,
  MAX(last_modified) as newest_update
FROM file_tracking
GROUP BY category, file_type
HAVING file_count > 1
ORDER BY avg_age_days ASC;
```

### Sync health monitoring
```sql
-- Monitor sync reliability and patterns
SELECT 
  source_system || ' → ' || target_system as sync_direction,
  COUNT(*) as total_syncs,
  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
  ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate,
  SUM(created_count) as total_created,
  SUM(updated_count) as total_updated,
  SUM(error_count) as total_errors,
  MAX(timestamp) as last_sync
FROM sync_log
WHERE timestamp > datetime('now', '-7 days')
GROUP BY sync_direction;
```

## 5. Smart Daily Briefing Query

### Everything I need to know for today
```sql
WITH today_events AS (
  SELECT 'EVENT' as type, title, datetime(start_date) as when_, location as details
  FROM calendar_events 
  WHERE DATE(start_date) = DATE('now')
),
urgent_tasks AS (
  SELECT 'TASK' as type, title, stage as when_, 'Due: ' || COALESCE(due_date, 'No date') as details
  FROM task_cache
  WHERE stage IN ('🔥 Immediate', '🚀 1st Priority', '📅 Scheduled')
  LIMIT 5
),
recent_important_emails AS (
  SELECT 'EMAIL' as type, 
    SUBSTR(subject, 1, 50) as title,
    from_address as when_,
    CASE WHEN has_been_replied_to = 0 THEN 'Needs reply' ELSE '' END as details
  FROM emails
  WHERE date > datetime('now', '-24 hours')
    AND from_address IN (
      SELECT email FROM contact_emails 
      WHERE contact_id IN (
        SELECT contact_id FROM people_to_contact WHERE completed = 0
      )
    )
  LIMIT 3
),
recommendations AS (
  SELECT 'RECOMMEND' as type, 
    recommendation as title,
    'Priority: ' || priority as when_,
    COALESCE(reason, '') as details
  FROM summary_recommendations
  WHERE status = 'pending'
    AND summary_date = DATE('now')
  LIMIT 3
)
SELECT * FROM today_events
UNION ALL
SELECT * FROM urgent_tasks
UNION ALL
SELECT * FROM recent_important_emails
UNION ALL
SELECT * FROM recommendations
ORDER BY type, when_;
```

## 6. Advanced Analytics

### Email response time analysis
```sql
WITH response_times AS (
  SELECT 
    e1.id as original_id,
    e1.from_address as sender,
    e1.subject,
    e1.date as sent_date,
    MIN(e2.date) as reply_date,
    (julianday(MIN(e2.date)) - julianday(e1.date)) * 24 as response_hours
  FROM emails e1
  LEFT JOIN emails e2 ON 
    e2.date > e1.date 
    AND e2.subject LIKE 'Re:%' || SUBSTR(e1.subject, 1, 30) || '%'
  WHERE e1.from_address NOT LIKE '%@%' -- external emails
  GROUP BY e1.id
)
SELECT 
  CASE 
    WHEN response_hours < 1 THEN '< 1 hour'
    WHEN response_hours < 24 THEN '1-24 hours'
    WHEN response_hours < 72 THEN '1-3 days'
    WHEN response_hours < 168 THEN '3-7 days'
    WHEN response_hours IS NULL THEN 'No response'
    ELSE '> 1 week'
  END as response_time,
  COUNT(*) as email_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) as percentage
FROM response_times
GROUP BY response_time
ORDER BY 
  CASE response_time
    WHEN '< 1 hour' THEN 1
    WHEN '1-24 hours' THEN 2
    WHEN '1-3 days' THEN 3
    WHEN '3-7 days' THEN 4
    WHEN '> 1 week' THEN 5
    WHEN 'No response' THEN 6
  END;
```

## Using These Queries

You can run any of these queries directly:
```bash
sqlite3 .data/today.db "YOUR_QUERY_HERE"
```

Or save frequently used queries as views:
```sql
CREATE VIEW daily_briefing AS
  [query content here];
  
-- Then simply:
SELECT * FROM daily_briefing;
```

These queries demonstrate the power of having all your data in a single, queryable database with proper relationships and indexes!
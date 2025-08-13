# Daily Plan - 2025-08-12

## Summary

Focus on critical ActiveStorage timeout/memory issues causing production outages, and core messaging functionality bugs. These P0 issues are actively breaking production and need immediate resolution.

## Critical/Urgent (P0)

- [ ] **ActiveStorage Image Timeout Crisis** (Issues #5231, #5232, #5211, #5222)
  - H12 timeout errors exceeding 30-second limit
  - Implement async variant generation (#5171)
  - Test memory usage with production-sized images
  
- [ ] **Memory Exhaustion Crisis** (Issue #5222, HoneyBadger R14)
  - 1,000,000+ occurrences, 87-95% memory usage
  - Fix ActiveStorage variant processing memory leaks
  - Implement memory-efficient image processing
  
- [ ] **Users Can't Empty Message Trash** (Issue #4628)
  - Core messaging functionality broken
  - Redirect occurs but messages remain in trash
  - Debug and fix the trash emptying logic
  
- [ ] **Email Confirmation Error Messages** (Issue #4304)
  - Server errors shown despite successful confirmation
  - Fix error handling in registration flow
  - Improve user feedback messages

## High Priority (P1)

- [ ] **Video Editing Authorization Failure** (Issue #4893)
  - Users getting "Unauthorized" when editing videos
  - Review PR #5283 fix attempt
  - Ensure proper authorization checks
  
- [ ] **Email Subscription Preferences Not Saving** (Issue #4604)
  - Profile updates fail to preserve settings
  - Fix causes R14 memory errors (>900MB)
  - Find memory-efficient solution
  
- [ ] **Broken Carousel Images** (Issue #5239)
  - Images return 200 OK but content-length: 0
  - Related to ActiveStorage proxy issues
  - Fix image serving pipeline

- [ ] **Images Missing File Attachment Flag** (Issue #5233)
  - Display issues for incorrectly flagged images
  - Run SQL analysis to assess scope
  - Update flags for affected images

## Medium Priority (P2)

- [ ] **Pagy Pagination Errors** (HoneyBadger, 19,948+ occurrences)
  - "page and keyset are not consistent" errors
  - Fix mixed cursor/page parameters
  - Update to Pagy 9.0 compatible code
  
- [ ] **Database Query Performance**
  - Slow queries on users#index (8,702+ notices)
  - Response times averaging 145-149ms
  - Add database indexes and optimize queries
  
- [ ] **Mailboxer Polymorphic Association Errors** (#121835041)
  - Cannot eagerly load receiver association
  - 408+ notices in mailbox#inbox
  - Fix eager loading strategy

- [ ] **Video Index Parameter Errors** (#121769633, #121725644)
  - Symbol/Integer conversion errors
  - Undefined method 'id' for nil
  - Add proper parameter validation

## Low Priority (P3)

- [ ] Account Creation Issues (Front Conversations)
  - reCaptcha verification problems
  - Review and respond to Front messages
  
- [ ] Geographic Address Resolution (Issue #4659)
  - Sint Maarten addresses resolving incorrectly
  
- [ ] UI/UX Improvements
  - Action buttons layout (#4514)
  - Past events user additions (#4515)
  - Groups sorting issues (#4593)

## Completed

- [x] Synced production data with bin/sync-data
- [x] Reviewed all archived data for open issues
- [x] Created prioritized daily plan

## Notes

- ActiveStorage issues are causing cascading failures across image/video features
- Memory pressure is the root cause of many production issues
- Need architectural solution for async variant generation
- Database performance optimization needed to reduce memory usage
- Multiple users reporting messaging and registration issues

## Carry Forward from Previous Days

- Video editing permissions fix attempt in PR #5283 needs review
- Memory optimization work from 2025-08-09 needs continuation
- Email subscription fix needs memory-efficient implementation

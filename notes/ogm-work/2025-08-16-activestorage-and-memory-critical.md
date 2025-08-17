# Daily Plan - 2025-08-16

## Summary

Critical focus on ActiveStorage image system failures and memory exhaustion issues that are breaking production. Multiple users unable to view images, memory consistently at 90% causing crashes.

## Critical/Urgent (P0)

### ActiveStorage Image System Breakdown
- [x] **Fix proxy URLs returning empty content** (#5231, #5232) - DEPLOYED PR #5301
- [ ] **Fix S3 redirect URLs returning 403 Forbidden** (#5233) - Permission issues blocking images
- [ ] **Fix missing file_attached flags** - Database records not properly flagged
- [ ] **Fix broken carousel images on group pages** (#5239) - Empty content responses

### Memory Exhaustion Crisis
- [x] **Investigate memory usage at 87-90%** (#5222) - 870-976MB of 1GB limit - PR #5306
- [x] **Fix ActiveStorage variant generation memory spikes** - Causing production crashes - PR #5306
- [x] **Implement memory optimization for image processing** - Prevent OOM errors - PR #5306

### H12 Request Timeouts
- [ ] **Fix 30-second timeouts on image processing** (#5211) - Synchronous variant generation
- [ ] **Implement async variant generation** (#5171) - Move to background jobs

## High Priority (P1)

### JSON Parser Errors
- [ ] **Fix "Backend action does not exist" errors** - API communication failures
- [ ] **Fix "Unexpected end of input" parser errors** (#4437, #4570)
- [ ] **Add JSON error handling and recovery**

### ActiveRecord Polymorphic Association Errors
- [ ] **Fix "Cannot eagerly load polymorphic :receiver"** - 800+ occurrences
- [ ] **Fix mailbox/inbox action failures** - Breaking messaging system

### Video Search TypeError
- [ ] **Fix "no implicit conversion of Symbol into Integer"** - Video index crashes
- [ ] **Fix params[:q]&.[](:s) parameter handling**

### Database Performance
- [ ] **Fix N+1 queries in attachment loading** - 6+ second load times
- [ ] **Optimize Users index queries** - Severe performance degradation

## Medium Priority (P2)

### Front Customer Support
- [ ] **Resolve profile picture change issue** - User can't add new picture after deletion
- [ ] **Process unassigned support conversations** - Multiple pending

### UI/UX Issues
- [ ] **Fix action buttons layout** (#4514) - Should be side-by-side
- [ ] **Fix past events user options** (#4515) - Showing incorrect options
- [ ] **Fix groups sorting** (#4593) - Incorrect order
- [ ] **Fix email subscription preferences** (#4604) - Not updating

## Low Priority (P3)

### Data Quality
- [ ] Geographic resolution for Sint Maarten (#4659)
- [ ] User validation errors (#4625, #4626, #4629)
- [ ] Remove "No trips found" messages (#4594)
- [ ] Fix message trash emptying (#4628)

## Completed

- [x] Synced production data with bin/sync-data
- [x] Reviewed all archived data for critical issues
- [x] Created daily plan with prioritized tasks
- [x] **Fixed ActiveStorage proxy URLs returning empty content** (#5231, #5232) - PR #5301
  - Enhanced proxy controller with fallback to streaming
  - Added error handling for S3 URL generation failures
  - Fixed variant proxy to handle missing records gracefully
  - Deployed to staging, load tested (0 errors/timeouts), promoted to production
  - Production deployment at 21:24 UTC - monitoring for stability
- [x] **Added memory monitoring to variant generation** - PR #5303
  - Added memory usage checks before processing
  - Delays jobs when memory usage exceeds 85%
  - Deployed to production
- [x] **Fixed video search TypeError** - PR #5305
  - Fixed "no implicit conversion of Symbol into Integer" error
  - Changed params[:q] access to safe type checking
  - Prevents crashes when params[:q] is not a Hash
  - Resolved HoneyBadger fault #122379098
- [x] **Fixed critical memory exhaustion** - PR #5306
  - Adjusted Sidekiq memory killer thresholds for Standard-2X dynos
  - Raised threshold from 400MB to 850MB (1GB dynos)
  - Optimized VIPS to use 50% less memory
  - Worker now stable, no crashes since fix
- [x] **Fixed pagination UX issue** (#5100) - PR #5307
  - Removed artificial 1000 page limit
  - Users can now access all visible page numbers
  - No more redirects to page 1

## Notes

### Critical Observations
- ActiveStorage system is completely broken for many users
- Memory exhaustion is causing production instability
- Multiple correlated issues suggest systemic problems with image handling
- JSON parsing errors affecting multiple API integrations

### Performance Metrics (Aug 15-16)
- Average Response: 135ms (acceptable)
- 95th Percentile: 333ms (acceptable)
- Error Rate: 0.3% (concerning for critical paths)
- Queue Time Spikes: Up to 964ms during image processing

### Action Items for Tomorrow
- Continue ActiveStorage fixes if not completed
- Monitor memory usage after optimizations
- Review HoneyBadger for new errors
- Check Front for new support issues
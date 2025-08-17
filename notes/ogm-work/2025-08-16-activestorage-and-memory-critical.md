# Daily Plan - 2025-08-16

## Summary

Critical focus on ActiveStorage image system failures and memory exhaustion issues that are breaking production. Multiple users unable to view images, memory consistently at 90% causing crashes.

## Critical/Urgent (P0)

### ActiveStorage Image System Breakdown

- [x] **Fix proxy URLs returning empty content** (#5231, #5232) - DEPLOYED PR #5301 <!-- task-id: 90ea86a2f8dded67fe3ef2d9f95fec1c -->
- [ ] **Fix S3 redirect URLs returning 403 Forbidden** (#5233) - Permission issues blocking images <!-- task-id: 5c4172b29f9182af4ffcba0d1dc6810f -->
- [ ] **Fix missing file_attached flags** - Database records not properly flagged <!-- task-id: 646b6c7c8fead6bcbcd7d734a1ba899d -->
- [ ] **Fix broken carousel images on group pages** (#5239) - Empty content responses <!-- task-id: b544a777d2ab5b07f910e35139fe0178 -->

### Memory Exhaustion Crisis

- [x] **Investigate memory usage at 87-90%** (#5222) - 870-976MB of 1GB limit - PR #5306 <!-- task-id: 1f4c466bf4f9e9e23eac47a5d7ed0790 -->
- [x] **Fix ActiveStorage variant generation memory spikes** - Causing production crashes - PR #5306 <!-- task-id: 2089e3c2b21d2929ba6bd709880c2bf3 -->
- [x] **Implement memory optimization for image processing** - Prevent OOM errors - PR #5306 <!-- task-id: 6eaee92f976e16ec8b2bae28d065f4bb -->

### H12 Request Timeouts

- [ ] **Fix 30-second timeouts on image processing** (#5211) - Synchronous variant generation <!-- task-id: 0a739968081e77c545d89f5d6c03111a -->
- [ ] **Implement async variant generation** (#5171) - Move to background jobs <!-- task-id: 7243577da864f8165c92a3796f3a0d98 -->

## High Priority (P1)

### JSON Parser Errors

- [ ] **Fix "Backend action does not exist" errors** - API communication failures <!-- task-id: 5f97d954a632b05d75f008b5d76da2bc -->
- [ ] **Fix "Unexpected end of input" parser errors** (#4437, #4570) <!-- task-id: 89c3cd70ec6c26fd47327dbc31ee1576 -->
- [ ] **Add JSON error handling and recovery** <!-- task-id: dff7f2ad88a62aa388baa99dcfc73ca1 -->

### ActiveRecord Polymorphic Association Errors

- [ ] **Fix "Cannot eagerly load polymorphic :receiver"** - 800+ occurrences <!-- task-id: 6288c0089dc96ce82c11ba21c10332a2 -->
- [ ] **Fix mailbox/inbox action failures** - Breaking messaging system <!-- task-id: 380400757fdb9a7c7dd6880857072f3b -->

### Video Search TypeError

- [ ] **Fix "no implicit conversion of Symbol into Integer"** - Video index crashes <!-- task-id: 44702486b897e57e429226497a580dd3 -->
- [ ] **Fix params[:q]&.[](:s) parameter handling** <!-- task-id: 5ec6bcc3e357acc9b4baa664e3beac1b -->

### Database Performance

- [ ] **Fix N+1 queries in attachment loading** - 6+ second load times <!-- task-id: 231592e4e9282a7ae3d2533f3341fe3a -->
- [ ] **Optimize Users index queries** - Severe performance degradation <!-- task-id: 66ae3253e85a0b2b23d240ff7313de4b -->

## Medium Priority (P2)

### Front Customer Support

- [ ] **Resolve profile picture change issue** - User can't add new picture after deletion <!-- task-id: 564631eef91c168208bfe0c482650d37 -->
- [ ] **Process unassigned support conversations** - Multiple pending <!-- task-id: c2ea6faf829d7e428433d54375fb2a0b -->

### UI/UX Issues

- [ ] **Fix action buttons layout** (#4514) - Should be side-by-side <!-- task-id: 24b14394cadad367ddd81aa27e41f25a -->
- [ ] **Fix past events user options** (#4515) - Showing incorrect options <!-- task-id: 006b494b94e4c2ce5d6689b5c6ac5074 -->
- [ ] **Fix groups sorting** (#4593) - Incorrect order <!-- task-id: 648c3f569f9cbe7c79e3c5d262a3d96b -->
- [ ] **Fix email subscription preferences** (#4604) - Not updating <!-- task-id: 1da9034991196482900e30f9e83b47b2 -->

## Low Priority (P3)

### Data Quality

- [ ] Geographic resolution for Sint Maarten (#4659) <!-- task-id: f3a6089bd1bca5e7dc7b47b4aac896ae -->
- [ ] User validation errors (#4625, #4626, #4629) <!-- task-id: 7cfaaa6e5b5a8ab5472812df51700dd9 -->
- [ ] Remove "No trips found" messages (#4594) <!-- task-id: dc7547edb6e939563f8c121b3c83ec35 -->
- [ ] Fix message trash emptying (#4628) <!-- task-id: eeeb1bb05d4ba01c15c8e560ce750415 -->

## Completed

- [x] Synced production data with bin/sync-data <!-- task-id: 1c517b025091678ab40befd5f87fcba5 -->
- [x] Reviewed all archived data for critical issues <!-- task-id: 1ea25bd88eff0861043559f2da6cb012 -->
- [x] Created daily plan with prioritized tasks <!-- task-id: fc31c95980b2e3630dc93d31072a74fc -->
- [x] **Fixed ActiveStorage proxy URLs returning empty content** (#5231, #5232) - PR #5301 <!-- task-id: 355953223586f8d70490df38f7212186 -->
  - Enhanced proxy controller with fallback to streaming
  - Added error handling for S3 URL generation failures
  - Fixed variant proxy to handle missing records gracefully
  - Deployed to staging, load tested (0 errors/timeouts), promoted to production
  - Production deployment at 21:24 UTC - monitoring for stability
- [x] **Added memory monitoring to variant generation** - PR #5303 <!-- task-id: f57f94ace5a71f9a9b2a2e63dd77746a -->
  - Added memory usage checks before processing
  - Delays jobs when memory usage exceeds 85%
  - Deployed to production
- [x] **Fixed video search TypeError** - PR #5305 <!-- task-id: 67a98ff53cc98c34e97389b4c5887941 -->
  - Fixed "no implicit conversion of Symbol into Integer" error
  - Changed params[:q] access to safe type checking
  - Prevents crashes when params[:q] is not a Hash
  - Resolved HoneyBadger fault #122379098
- [x] **Fixed critical memory exhaustion** - PR #5306 <!-- task-id: 56c97993a7569680b789c6a31d5cabcc -->
  - Adjusted Sidekiq memory killer thresholds for Standard-2X dynos
  - Raised threshold from 400MB to 850MB (1GB dynos)
  - Optimized VIPS to use 50% less memory
  - Worker now stable, no crashes since fix
- [x] **Fixed pagination UX issue** (#5100) - PR #5307 <!-- task-id: cafae5ac60349a0d9c2e085bd0f254fd -->
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

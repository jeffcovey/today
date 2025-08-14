# Daily Plan - 2025-08-13

## Summary

Focus on timeout issues, performance problems, and JSON parsing errors that are affecting production. The majority of HoneyBadger faults are Rack::Timeout exceptions indicating serious performance issues.

## Critical/Urgent (P0)

- [x] **Rack::Timeout Issues** - Multiple faults showing 25-30 second wait times
  - Fault 108553660: Request waited 28136ms (users#index)
  - Fault 108603919: Request waited 28448ms
  - Fault 108610383: Request waited 28939ms
  - FIXED: Added request queue monitoring, early abort, and query optimizations

## High Priority (P1)

- [x] **JSON Parsing Errors** (Issues #4437, #4570)
  - Unexpected character errors from backend
  - Patreon API returning HTML instead of JSON
  - FIXED: Created SafeJsonParser service and implemented across all API integrations
  - DEPLOYED: Successfully deployed to production with 0 errors in load tests

- [x] **Email Confirmation Links Broken** (Issue #4304)
  - Users cannot confirm their email addresses
  - Critical for new user onboarding
  - FIXED: Corrected undefined method `signed_in_root_path` in confirmations controller

## Medium Priority (P2)

- [ ] **UI/UX Issues**
  - Issue #4514: Action buttons should be side-by-side
  - Issue #4515: Past Events showing incorrect options

- [ ] **Front Conversations**
  - 9 open conversations needing attention
  - Review and respond to user support requests

## Low Priority (P3)

- [ ] Code cleanup from previous fixes
- [ ] Documentation updates

## Completed

- [x] Fixed master-index.json Ruby underscore notation in numbers
- [x] Added defensive JSON parsing to honeybadger script
- [x] Fixed all archived JSON files with underscore notation
- [x] Successfully ran sync-data without errors
- [x] **Rack::Timeout Issues** - Added request queue monitoring and early abort for long-queued requests
- [x] **Added Request Queue Monitoring** - New middleware to track and abort requests waiting too long
- [x] **Optimized Users#index** - Reduced max distance to 100mi, added aggressive caching for geo searches
- [x] **Fixed Email Confirmation Links** (Issue #4304) - Fixed undefined method error in confirmations controller
- [x] **Database Query Optimization** - Added query killer for runaway queries and statement timeouts
- [x] **Circuit Breakers** - Implemented circuit breaker pattern for external API calls (Patreon, Discourse, etc.)
- [x] **JSON Parsing Errors** (Issues #4437, #4570) - Created SafeJsonParser service with comprehensive error handling
- [x] **Defensive JSON Parsing** - Updated all API integrations to use SafeJsonParser

## Notes

- Performance issues are critical - users experiencing 25-30 second wait times
- Need to investigate what's causing the long request queuing times
- JSON parsing errors suggest multiple API integrations are fragile
- Consider implementing circuit breakers for external API calls

## Next Steps

1. Investigate timeout root causes - likely database queries or external API calls
2. Add comprehensive error handling for all JSON parsing
3. Review email confirmation flow for breaking changes

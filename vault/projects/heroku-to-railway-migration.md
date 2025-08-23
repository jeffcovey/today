Created: August 22, 2025
<!-- project-id: 425acc1aeab4181f15a9980483990951 -->
Status: Planning
Priority: HIGH
Parent Project: [Financial Improvement 2025](financial-improvement-2025.md)
Est. Savings: $583/month ($6,996/year)

# Heroku to Railway Migration

## Executive Summary

This project aims to migrate all applications and services from Heroku to Railway.app, reducing hosting costs from $733/month to approximately $150/month while maintaining performance and reliability. This migration is a critical component of the broader [Financial Improvement 2025](./financial-improvement-2025.md) initiative.

## Current State Analysis

### Heroku Infrastructure (Monthly: $733)

After downgrading from Performance-L to Standard-2X (completed August 2025):
- **Standard-2X dyno**: $50/mo (reduced from $500/mo Performance-L)
- **Standard dynos**: $237/mo (various applications)
- **PostgreSQL databases**: ~$200/mo (standard-0 + essential-0)
- **Redis instances**: ~$100/mo (premium-3 + mini)
- **Add-ons**: ~$146/mo
  - Papertrail logging
  - Scheduler
  - SendGrid Gold
  - Other services

### Applications Inventory

*To be completed during Week 1 analysis*
- [ ] List all Heroku applications <!-- task-id: e61eb74c16bed2fa39837f368a851a77 -->
- [ ] Document dependencies between apps <!-- task-id: 1251c6ea3301d6480deee331c57fc9bb -->
- [ ] Identify critical vs non-critical services <!-- task-id: 105133fa9801d93feb28aa7ed4a6291c -->
- [ ] Note traffic patterns and resource usage <!-- task-id: 5608e870d32bc7770f24148f94a8fce3 -->

## Target Architecture

### Railway Setup (Estimated Monthly: $150)

- **Production services**: $40/mo
- **PostgreSQL**: $20/mo
- **Redis**: $10/mo
- **Cron jobs**: Included
- **Logging**: Free tier
- **Email service**: AWS SES ($10/mo)
- **Monitoring**: Free tier / $10/mo
- **Backup storage**: $10/mo
- **Buffer for scaling**: $50/mo

### Cost Comparison

| Service | Heroku | Railway | Savings |
|---------|--------|---------|---------|
| Compute | $287 | $40 | $247 |
| PostgreSQL | $200 | $20 | $180 |
| Redis | $100 | $10 | $90 |
| Logging | $50 | $0 | $50 |
| Scheduler | $30 | $0 | $30 |
| Email | $66 | $10 | $56 |
| **Total** | **$733** | **$150** | **$583** |

## Migration Plan - Staged Approach

### Key Insight: Decouple Services for Immediate Savings

Yes, absolutely! We can migrate in stages. Since your Discourse instance is already externally hosted and just interacts with your site via APIs, we can apply the same principle to other services. **The biggest cost savings come from migrating databases and Redis first** - these can run on Railway while your Heroku apps continue to connect to them remotely.

### Migration Priority Analysis (Biggest Cost Impact First)

#### Highest Impact Migrations (Move First - $370/mo savings)

1. **PostgreSQL Databases ($200/mo → $20/mo)**
   - **Why First**: Easiest to decouple, biggest single cost item
   - Can run on Railway while ALL apps stay on Heroku
   - Heroku apps connect via DATABASE_URL to Railway PostgreSQL
   - Zero code changes required, just update connection string
   - **Immediate savings: $180/mo**

2. **Redis Instances ($100/mo → $10/mo)**
   - **Why Second**: Simple connection string change
   - Used for caching/sessions - easily moved
   - Heroku apps connect via REDIS_URL to Railway Redis
   - Can test with non-critical cache first
   - **Immediate savings: $90/mo**

3. **Add-on Services ($146/mo → $46/mo)**
   - **SendGrid Gold ($66/mo)** → AWS SES or Resend ($10/mo)
   - **Papertrail ($50/mo)** → Railway logs (free) or Betterstack ($0-10/mo)
   - **Scheduler ($30/mo)** → Railway cron jobs (included)
   - These are API-based services, easy to swap
   - **Immediate savings: $100/mo**

#### Medium Impact (Move Second)

4. **Non-critical/Low-traffic Apps**
   - Development/staging environments
   - Internal tools
   - Low-traffic services
   - Savings: Variable

#### Keep on Heroku Initially

5. **Main Production Application**
   - Customer-facing services
   - Revenue-critical components
   - Complex integrations
   - Move last after proving Railway stability

### Staged Migration Phases

#### Stage 1: Database & Cache Migration (Week 1-2)

**Timeline:** August 23 - September 5, 2025  
**Potential Savings:** $270/month

##### PostgreSQL Migration

- [ ] Set up Railway PostgreSQL instance <!-- task-id: p1-001 -->
- [ ] Configure connection pooling <!-- task-id: p1-002 -->
- [ ] Set up read replica from Heroku <!-- task-id: p1-003 -->
- [ ] Test connection from Heroku apps <!-- task-id: p1-004 -->
- [ ] Implement automated backups <!-- task-id: p1-005 -->
- [ ] Switch Heroku apps to use Railway DB <!-- task-id: p1-006 -->
- [ ] Monitor for 48 hours <!-- task-id: p1-007 -->
- [ ] Decommission Heroku PostgreSQL <!-- task-id: p1-008 -->

##### Redis Migration  

- [ ] Create Railway Redis instance <!-- task-id: r1-001 -->
- [ ] Export Redis data from Heroku <!-- task-id: r1-002 -->
- [ ] Import data to Railway Redis <!-- task-id: r1-003 -->
- [ ] Update connection strings in Heroku apps <!-- task-id: r1-004 -->
- [ ] Test cache operations <!-- task-id: r1-005 -->
- [ ] Monitor performance <!-- task-id: r1-006 -->
- [ ] Cancel Heroku Redis <!-- task-id: r1-007 -->

#### Stage 2: Add-ons & Services Migration (Week 3)

**Timeline:** September 6-12, 2025  
**Potential Savings:** $146/month

##### Logging Migration

- [ ] Evaluate Railway's built-in logging <!-- task-id: l2-001 -->
- [ ] Set up log aggregation if needed <!-- task-id: l2-002 -->
- [ ] Export historical logs from Papertrail <!-- task-id: l2-003 -->
- [ ] Update log shipping configuration <!-- task-id: l2-004 -->
- [ ] Cancel Papertrail <!-- task-id: l2-005 -->

##### Email Service Migration

- [ ] Set up AWS SES or Resend <!-- task-id: e2-001 -->
- [ ] Migrate email templates <!-- task-id: e2-002 -->
- [ ] Update SMTP settings <!-- task-id: e2-003 -->
- [ ] Test email delivery <!-- task-id: e2-004 -->
- [ ] Cancel SendGrid Gold <!-- task-id: e2-005 -->

##### Scheduled Jobs

- [ ] Document all Heroku Scheduler tasks <!-- task-id: s2-001 -->
- [ ] Set up Railway cron jobs <!-- task-id: s2-002 -->
- [ ] Test job execution <!-- task-id: s2-003 -->
- [ ] Monitor for failures <!-- task-id: s2-004 -->

#### Stage 3: Non-Critical Applications (Week 4-5)

**Timeline:** September 13-26, 2025  
**Potential Savings:** $100-150/month

- [ ] Identify non-critical applications <!-- task-id: nc3-001 -->
- [ ] Deploy to Railway one at a time <!-- task-id: nc3-002 -->
- [ ] Test each application thoroughly <!-- task-id: nc3-003 -->
- [ ] Update DNS/routing as needed <!-- task-id: nc3-004 -->
- [ ] Monitor for issues <!-- task-id: nc3-005 -->
- [ ] Keep Heroku as backup for 1 week <!-- task-id: nc3-006 -->

#### Stage 4: Critical Applications (Week 6-8)

**Timeline:** September 27 - October 10, 2025  
**Potential Savings:** $167/month

- [ ] Create detailed migration plan <!-- task-id: c4-001 -->
- [ ] Set up blue-green deployment <!-- task-id: c4-002 -->
- [ ] Migrate during low-traffic window <!-- task-id: c4-003 -->
- [ ] Implement instant rollback capability <!-- task-id: c4-004 -->
- [ ] Monitor intensively for 2 weeks <!-- task-id: c4-005 -->
- [ ] Gradually decommission Heroku <!-- task-id: c4-006 -->

### Hybrid Architecture During Migration

#### How the Hybrid Setup Works

**Current State (All on Heroku):**

```
Heroku App → Heroku PostgreSQL ($200/mo)
           → Heroku Redis ($100/mo)
           → SendGrid API ($66/mo)
           → Papertrail ($50/mo)
```

**Stage 1 Hybrid (Databases on Railway):**

```
Heroku App → Railway PostgreSQL ($20/mo) [via DATABASE_URL]
           → Railway Redis ($10/mo) [via REDIS_URL]
           → SendGrid API ($66/mo)
           → Papertrail ($50/mo)
```

Savings: $270/mo with ZERO app code changes!

**Stage 2 Hybrid (Add Services on Railway/External):**

```
Heroku App → Railway PostgreSQL ($20/mo)
           → Railway Redis ($10/mo)
           → AWS SES ($10/mo) [via SMTP settings]
           → Railway Logs (free) [via log drain]
```

Savings: $370/mo total

#### Connectivity Requirements

- Heroku apps → Railway databases via connection string
- Railway provides public connection URLs for all services
- SSL/TLS encryption for all connections
- Connection pooling to manage connection limits

#### Network Security & Performance

- [ ] Get Railway database connection strings <!-- task-id: ns-001 -->
- [ ] Test connection latency (expect 5-20ms between providers) <!-- task-id: ns-002 -->
- [ ] Set up connection pooling (PgBouncer if needed) <!-- task-id: ns-003 -->
- [ ] Configure SSL certificates <!-- task-id: ns-004 -->
- [ ] Set up monitoring for cross-platform connections <!-- task-id: ns-005 -->
- [ ] Document all connection strings securely <!-- task-id: ns-006 -->

### Cost Impact Timeline

| Stage | Component | Time | Monthly Savings | Cumulative | Risk Level |
|-------|-----------|------|-----------------|------------|------------|
| 1a | PostgreSQL to Railway | Week 1 | $180 | $180 | Low |
| 1b | Redis to Railway | Week 1 | $90 | $270 | Low |
| 2 | Add-ons (Email, Logs, Cron) | Week 2 | $100 | $370 | Low |
| 3 | Non-critical Apps | Week 3-4 | $100 | $470 | Medium |
| 4 | Critical Apps | Week 5-8 | $113 | $583 | High |

**Key Point**: After just 2 weeks, you'll save $370/month (50% of total) with minimal risk!

### Quick Win Opportunities

#### Week 1 Quick Wins (Start Immediately)

**Day 1-2: Database Migration Prep**
1. Sign up for Railway account
2. Create Railway PostgreSQL instance ($20/mo)
3. Use `pg_dump` to backup Heroku database
4. Restore to Railway using `pg_restore`
5. Get Railway DATABASE_URL

**Day 3-4: Test & Switch**
1. Clone your Heroku app to a test environment
2. Update test app's DATABASE_URL to point to Railway
3. Run full test suite
4. If tests pass, update production DATABASE_URL
5. **Immediate savings: $180/month!**

**Day 5: Redis Migration**
1. Create Railway Redis instance ($10/mo)
2. Get Railway REDIS_URL
3. Update Heroku app's REDIS_URL
4. Clear and warm cache
5. **Additional savings: $90/month!**

#### What Stays on Heroku (For Now)

- All application code and dynos
- Complex integrations
- Customer-facing services
- File storage/uploads
- Background workers

This approach gives you immediate cost relief while maintaining stability!

## Technical Requirements

### Migration Tools Needed

- Database migration tools (pg_dump, pg_restore)
- Redis data migration scripts
- DNS management access
- Git repositories access
- Environment variable management
- Log aggregation solution

### Railway-Specific Configurations

```yaml
# Example railway.json configuration
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Database Migration Strategy

1. Set up read replica on Railway
2. Sync data continuously during transition
3. Switch writes to Railway at cutover
4. Verify data integrity
5. Decommission Heroku database

## Risk Assessment & Mitigation

### Identified Risks

#### High Risk

- **Data Loss During Migration**
  - Mitigation: Multiple backups, staged migration, data validation
  - Contingency: Restore from backup, stay on Heroku

- **Extended Downtime**
  - Mitigation: Blue-green deployment, thorough testing
  - Contingency: Immediate rollback to Heroku

#### Medium Risk

- **Performance Degradation**
  - Mitigation: Load testing, performance benchmarking
  - Contingency: Scale Railway resources, optimize code

- **Integration Failures**
  - Mitigation: Test all integrations in staging
  - Contingency: Use Railway's support, implement workarounds

#### Low Risk

- **Cost Overruns**
  - Mitigation: Set up billing alerts, monitor usage
  - Contingency: Optimize resources, consider alternatives

## Success Criteria

### Week 1 Success Metrics

- [ ] Complete application inventory <!-- task-id: 2e638c8a00a95336635aecee807f63c7 -->
- [ ] Railway account ready <!-- task-id: 26e1ca4cef375517075f346231e29bee -->
- [ ] Migration plan reviewed and approved <!-- task-id: dd7f3146831576b89c5fbe588e05608c -->

### Week 2 Success Metrics

- [ ] Staging environment fully functional <!-- task-id: f075e1553b232065a1633b5c8788142c -->
- [ ] Performance benchmarks documented <!-- task-id: 573755ae67782bf4d4f8f0f0529344a5 -->
- [ ] All tests passing <!-- task-id: 290b466916f8f2e87e4d748f400be53d -->

### Week 3-4 Success Metrics

- [ ] Zero data loss <!-- task-id: 1c03dfa9e047d0379ab306186b0d2ca0 -->
- [ ] Downtime < 5 minutes <!-- task-id: f87170338c23d219de5489bc7654bfa5 -->
- [ ] All applications running on Railway <!-- task-id: 69135995a4ecd456c90cc61fbccfdf1f -->
- [ ] Monitoring showing stable performance <!-- task-id: 679366569e9d15342143a2273a200c99 -->

### 30-Day Success Criteria

- [ ] 99.9% uptime achieved <!-- task-id: c1b5f9a053f6d293ceccded84e4b5420 -->
- [ ] Monthly cost < $200 <!-- task-id: 55e77c49fdfa541cda703f5f2c279ad9 -->
- [ ] No critical issues <!-- task-id: f6bed0e369c64179a5112f735323f91a -->
- [ ] Team comfortable with Railway <!-- task-id: f0569e4ee9eeed3fcd9b61f4f4120c96 -->
- [ ] Heroku fully decommissioned <!-- task-id: f06def31b50687cbb5b3677dbecc4589 -->

## Budget & Resources

### Migration Costs

- Railway (parallel running): $150/month
- Heroku (during migration): $733/month
- Additional tools/services: $50
- **Total during migration**: $933/month

### Post-Migration Savings

- Monthly savings: $583
- Annual savings: $6,996
- ROI period: 2 months

### Time Investment

- Planning: 10 hours
- Implementation: 40 hours
- Testing: 20 hours
- Documentation: 10 hours
- **Total**: 80 hours

## Alternative Options Considered

### Option B: Self-Hosted VPS

- **Pros**: Maximum control, lowest cost (~$100/mo)
- **Cons**: Requires DevOps expertise, more maintenance
- **Decision**: Railway chosen for managed services and easier maintenance

### Option C: Other PaaS Providers

- **Render.com**: Similar pricing, less mature platform
- **Fly.io**: More complex, better for edge computing
- **DigitalOcean App Platform**: More expensive than Railway
- **Decision**: Railway offers best balance of features and cost

## Monitoring & Maintenance

### Key Metrics to Track

- Application response times
- Database query performance
- Error rates
- Monthly costs
- Resource utilization
- Uptime percentage

### Monthly Review Checklist

- [ ] Review Railway invoices <!-- task-id: cf27ff49a6f64c1a66011b8b260b0de5 -->
- [ ] Analyze performance metrics <!-- task-id: 234fc807e3410967fcad22bc0ba33a43 -->
- [ ] Check for unused resources <!-- task-id: efe089183dfc081694cb4ff2210cef41 -->
- [ ] Review scaling needs <!-- task-id: 0a740e1512f86846ed49d3507fd27822 -->
- [ ] Update documentation <!-- task-id: d99096775eb00ff5880cd3e1ced9ea92 -->
- [ ] Security patches applied <!-- task-id: 4ee5a0625beb0f87ba45342f230d706c -->

## Documentation & Training

### Documentation Needed

- [ ] Railway deployment guide <!-- task-id: e5ae9be2945154519a4c457e94a185c1 -->
- [ ] Environment variable reference <!-- task-id: d66449e33ea78849c381a8f91dcf2552 -->
- [ ] Troubleshooting guide <!-- task-id: 24674390c584c20542e1204942c7b01d -->
- [ ] Disaster recovery procedures <!-- task-id: 616f3a18bb96e850371989291b31bd60 -->
- [ ] Architecture diagrams <!-- task-id: db5759430e989fb846ea6d62cd10044e -->
- [ ] API endpoint mappings <!-- task-id: 811eeea667194df7a4877193b35a8a2f -->

### Team Training Topics

- Railway CLI usage
- Deployment procedures
- Monitoring and alerts
- Troubleshooting common issues
- Cost optimization techniques

## Next Actions

### Immediate (Today - August 22)

- [ ] Review and refine this migration plan <!-- task-id: 2e718d3fcc291863969897f9de698892 -->
- [ ] Get stakeholder approval <!-- task-id: ae38239137d5d9967e83ed746b4f8fd7 -->
- [ ] Create Railway account <!-- task-id: 3847510bdce6fe62b4820af567bddd62 -->
- [ ] Schedule migration kickoff meeting <!-- task-id: e89e83ce35294e28ee560205492c4170 -->

### This Week (by August 29)

- [ ] Complete application inventory <!-- task-id: 2cceb616bf672933cb1b545657e72f79 -->
- [ ] Begin documenting current architecture <!-- task-id: 71d590f18017af84dee3706d0c5c7212 -->
- [ ] Start backing up all data <!-- task-id: 7995a0b11a81ad8264b9ce43a9442484 -->
- [ ] Research Railway-specific requirements <!-- task-id: a8c3fe058e246c8b34cf08fb355ecc6d -->

### Next Week (by September 5)

- [ ] Deploy first app to Railway staging <!-- task-id: 7b217afe456229d2fdd3994afa383d96 -->
- [ ] Complete performance benchmarking <!-- task-id: a52872cba523fa5e6cc28a26278bbad2 -->
- [ ] Finalize migration schedule <!-- task-id: 405791c6d9e5a547d0e8c1f8034977d9 -->

## Notes & References

### Related Documentation

- [Financial Improvement 2025 Project](./financial-improvement-2025.md)
- [Heroku Invoice Analysis (July 2025)](../../documents/Heroku-Invoice-July-2025.html)
- Railway Documentation: https://docs.railway.app
- Railway Pricing: https://railway.app/pricing

### Key Decisions Log

- **August 2025**: Chose Railway over self-hosting for easier management
- **August 2025**: Decided on staged migration vs. big-bang approach
- **August 2025**: Completed Heroku Performance-L to Standard-2X downgrade (saved $450/mo)

### Lessons from Financial Review

- Small hosting charges add up significantly
- Multiple hosting providers indicate lack of consolidation
- Managed services worth it for reduced maintenance burden
- Migration can pay for itself in 2 months

---

**Project Owner**: [Your Name]  
**Review Schedule**: Weekly during migration, monthly after  
**Next Review**: August 29, 2025  
**Status Updates**: Every Friday at 3 PM

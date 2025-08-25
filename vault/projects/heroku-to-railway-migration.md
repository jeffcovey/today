# Heroku to Railway Migration

Created: August 22, 2025  
Status: In Progress  
Priority: HIGH  
Parent Project: [Financial Improvement 2025](financial-improvement-2025.md)  
Est. Remaining Savings: ~$400/month

## Executive Summary

Migrating applications from Heroku to Railway to reduce hosting costs from current ~$650/month to ~$150/month. Redis migration completed successfully on August 24, 2025 ($90/mo saved).

## Current State (August 24, 2025)

### ✅ Completed Migrations

- **Heroku Performance-L downgrade**: $450/mo saved
- **Redis to Railway**: $90/mo saved (August 24, 2025)
- **Papertrail**: Already on free tier

### 📊 Current Heroku Costs

**Monthly: ~$650** (after optimizations)
- Application dynos: ~$187/mo (Standard-2X + others)
- PostgreSQL database: $50/mo
- Add-ons: ~$400/mo
  - SendGrid Gold: $66/mo (review later)
  - Scheduler: $30/mo
  - Other services: ~$300/mo

### 🎯 Target Railway Costs

**Monthly: ~$150**
- Production services: $40/mo
- PostgreSQL: $20/mo
- Redis: $10/mo (✅ already migrated)
- Cron jobs: Included
- Email: AWS SES ($10/mo)
- Monitoring & backup: $20/mo
- Buffer: $50/mo

## Migration Roadmap

### Phase 1: PostgreSQL Migration 🔄 NEXT

**Savings: $30/month**
- [ ] Create Railway PostgreSQL instance ($20/mo)
- [ ] Backup Heroku database with `pg_dump`
- [ ] Restore to Railway with `pg_restore`
- [ ] Test connection from Heroku apps
- [ ] Update DATABASE_URL in production
- [ ] Monitor for 48 hours
- [ ] Cancel Heroku PostgreSQL

### Phase 2: Application Migration 📋 PLANNING

**Savings: ~$150/month**

#### Step 1: Inventory Applications

- [ ] Run `heroku apps` to list all apps
- [ ] Document which apps use which databases
- [ ] Identify critical vs non-critical apps
- [ ] Map environment variables needed

#### Step 2: Non-Critical Apps First

- [ ] Choose simplest/lowest traffic app
- [ ] Deploy to Railway
- [ ] Test thoroughly
- [ ] Switch DNS/traffic
- [ ] Monitor for issues

#### Step 3: Critical Apps

- [ ] Create detailed migration plan
- [ ] Set up blue-green deployment
- [ ] Migrate during low traffic
- [ ] Have rollback ready

### Phase 3: Remaining Add-ons

**Savings: ~$100/month**
- [ ] Migrate Scheduler to Railway cron jobs (save $30/mo)
- [ ] Evaluate remaining add-ons for alternatives
- [ ] Consolidate or eliminate redundant services

## Quick Start Guide

### This Week's Actions

1. **PostgreSQL Migration** (2-3 hours)

   ```bash
   # Backup Heroku database
   heroku pg:backups:capture
   heroku pg:backups:download
   
   # Create Railway PostgreSQL
   # Import data
   # Test connection
   ```

2. **Application Inventory** (1 hour)

   ```bash
   heroku apps
   heroku addons --all
   ```

3. **Create Railway Account** (if not done)
   - Set up billing
   - Familiarize with dashboard

## Risk Mitigation

### Low Risk Actions ✅

- Database migrations (connection string changes only)
- Non-critical app migrations
- Add-on replacements

### Medium Risk Actions ⚠️

- Critical app migrations
- DNS changes
- Customer-facing services

### Mitigation Strategies

- Always backup before migrating
- Test in staging first
- Keep Heroku running until verified
- Document rollback procedures

## Success Metrics

- **Cost Reduction**: From $650/mo to $150/mo
- **Performance**: Equal or better response times
- **Uptime**: Maintain 99.9%
- **Migration Time**: Complete by end of September 2025

## Key Decisions

- ✅ Chose Railway over self-hosting (easier management)
- ✅ Staged migration approach (lower risk)
- ✅ Redis migrated first (proven success)
- 🔄 PostgreSQL next (low risk, quick win)

## Notes

- Redis migration completed with zero downtime
- Papertrail already optimized (free tier)
- SendGrid kept for now (review later)
- Focus on biggest impact migrations first

---

**Next Review**: August 31, 2025  
**Questions?** Check [Railway Docs](https://docs.railway.app)

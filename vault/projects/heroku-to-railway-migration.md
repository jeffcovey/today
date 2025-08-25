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
- [ ] Create Railway PostgreSQL instance ($20/mo) <!-- task-id: f435b1326df607027a3f35b865dcb56f -->
- [ ] Backup Heroku database with `pg_dump` <!-- task-id: 92ac50a9815a52ceae69109094fee982 -->
- [ ] Restore to Railway with `pg_restore` <!-- task-id: 3ea3222bbc9f8bde49e89a3a74753ad1 -->
- [ ] Test connection from Heroku apps <!-- task-id: 88939374bb9416126f1c92e1ef613c4f -->
- [ ] Update DATABASE_URL in production <!-- task-id: 99854f2b20ac9923da44803e006b0c25 -->
- [ ] Monitor for 48 hours <!-- task-id: 18712a3e40dedcb7aa9e84833ebe0832 -->
- [ ] Cancel Heroku PostgreSQL <!-- task-id: 27d7cc6391d4045924601b55847376c2 -->

### Phase 2: Application Migration 📋 PLANNING

**Savings: ~$150/month**

#### Step 1: Inventory Applications

- [ ] Run `heroku apps` to list all apps <!-- task-id: e886f5a08e7ccfbb1249edab4f2dfabf -->
- [ ] Document which apps use which databases <!-- task-id: 9ce3982e73566044f83cf961a903891f -->
- [ ] Identify critical vs non-critical apps <!-- task-id: 8b334b2c64d2df62ea22670f2e312a90 -->
- [ ] Map environment variables needed <!-- task-id: c5f76eb0a4b545b1f4c434382a14fef2 -->

#### Step 2: Non-Critical Apps First

- [ ] Choose simplest/lowest traffic app <!-- task-id: c63117a66a5ae5e24c750530d6ebc70d -->
- [ ] Deploy to Railway <!-- task-id: 59e5dfcb4c7a172d9b0fb39015bb31fa -->
- [ ] Test thoroughly <!-- task-id: 8c104b8bf889abc3ed7c531ecc7b6dcf -->
- [ ] Switch DNS/traffic <!-- task-id: 636c7f47e7c604878130f9173735cc90 -->
- [ ] Monitor for issues <!-- task-id: 1f94b24c115eb539173a24b297c64257 -->

#### Step 3: Critical Apps

- [ ] Create detailed migration plan <!-- task-id: 4314d7e80995f25bb596d02ecbc6c7f0 -->
- [ ] Set up blue-green deployment <!-- task-id: 34bb13ad21b6485538f1e477cf6b34e0 -->
- [ ] Migrate during low traffic <!-- task-id: fcbc4b7bd82db44a22f5e438ba4c7270 -->
- [ ] Have rollback ready <!-- task-id: e1daf17228b1e95e9af444dae7cc5d6c -->

### Phase 3: Remaining Add-ons

**Savings: ~$100/month**
- [ ] Migrate Scheduler to Railway cron jobs (save $30/mo) <!-- task-id: 4a0561fb6f753fa12a7c9cc88c5ea2f8 -->
- [ ] Evaluate remaining add-ons for alternatives <!-- task-id: e3e240c29a7fde1583560466873af0d9 -->
- [ ] Consolidate or eliminate redundant services <!-- task-id: 803460f2395b0a7dfdfbf0165448957b -->

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

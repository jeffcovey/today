Created: August 22, 2025
<!-- project-id: 425acc1aeab4181f15a9980483990951 -->
Status: Planning
Priority: HIGH
Parent Project: [[financial-improvement-2025|Financial Improvement 2025]]
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

## Migration Plan

### Phase 1: Pre-Migration Analysis (Week 1)

**Dates**: August 23-29, 2025

#### Technical Inventory

- [ ] Export all Heroku environment variables <!-- task-id: a474dc47487ef7d1e7a6e38e62a15665 -->
- [ ] Document all Heroku applications and their purposes <!-- task-id: c930bc2108bf5dc796b1be2001c615b2 -->
- [ ] List all add-ons and their configurations <!-- task-id: 376c73a6f9941a0577fea25e1261b317 -->
- [ ] Analyze database sizes and schemas <!-- task-id: 3a97a92ac5c05b1d599e97074b02d8a6 -->
- [ ] Review application logs for traffic patterns <!-- task-id: 1436b90aea1d7ffe3d1414ed97c247c5 -->
- [ ] Document all cron jobs and scheduled tasks <!-- task-id: 678da3fc4c896d33ea83f42975445a70 -->
- [ ] Identify external service dependencies <!-- task-id: 2499b606d8117377828fc4d37d21a318 -->

#### Railway Preparation

- [ ] Create Railway account <!-- task-id: ad676d40b1bf35466f072c9b6c9e53aa -->
- [ ] Set up billing and alerts <!-- task-id: 252277d83a8ad5da074632a1d436a410 -->
- [ ] Review Railway documentation <!-- task-id: ef84374abcab75596cdde9b9a5e6616e -->
- [ ] Join Railway community/support channels <!-- task-id: 1982ac0f64e5ff075413e34ebb14b839 -->
- [ ] Test Railway CLI tools <!-- task-id: 30d1640bc5516cf83a5d2ddf4803c590 -->
- [ ] Understand Railway's deployment process <!-- task-id: d1bb32cd817262389ea4d79086bb7a62 -->

### Phase 2: Staging Environment (Week 2)

**Dates**: August 30 - September 5, 2025

#### Environment Setup

- [ ] Create Railway project for staging <!-- task-id: 07ff75b297cda72fac6b3f75fcb461a4 -->
- [ ] Deploy first application to Railway <!-- task-id: 2be62dc23b4ffb9fed69576ecdcd6fa5 -->
- [ ] Configure PostgreSQL database <!-- task-id: 027c20ecc09e3c3cf21d85eb3d9f0d1a -->
- [ ] Set up Redis instance <!-- task-id: 2ec1bab72df3d3c61e1fcbc1fe05a386 -->
- [ ] Configure environment variables <!-- task-id: d4b6f882cab39cec873013d2e5de4aad -->
- [ ] Set up custom domains (staging) <!-- task-id: 8c01d88130e51894892f46915d5c52fb -->
- [ ] Configure SSL certificates <!-- task-id: 9de537717a4458128e52dda0a9387a9f -->

#### Testing

- [ ] Test application functionality <!-- task-id: ceb099f7c86ba3936c8dd87a7a79291d -->
- [ ] Benchmark performance vs Heroku <!-- task-id: 90463c414567516aaaa732f897cbf7b9 -->
- [ ] Test database connections <!-- task-id: 5b660d9e1c915b957667fdee7d02e4c5 -->
- [ ] Verify Redis functionality <!-- task-id: b8d68afcdbaf75edf73ff47dfceb5ed7 -->
- [ ] Test scheduled jobs <!-- task-id: eb5bab6c56ff1580fa74a0b216c35e86 -->
- [ ] Load testing <!-- task-id: bcfac8a83fb4408e427c8f5c2ba474a5 -->
- [ ] Security scanning <!-- task-id: 12154bc497986e19ef7ba4d1267bb3af -->

### Phase 3: Production Migration (Week 3-4)

**Dates**: September 6-19, 2025

#### Week 3: Critical Services

- [ ] Backup all production data <!-- task-id: d58a7b87cc4794196c3aa029c465e28c -->
- [ ] Migrate primary database (with replication) <!-- task-id: 8b37823e56f3f253704f312ab4755ad6 -->
- [ ] Deploy main application <!-- task-id: cd20260b149da2f6ae667bd1bbd3d9f6 -->
- [ ] Configure production domains <!-- task-id: 0134e8d1e9b43c8499d67bc4bcba6d89 -->
- [ ] Set up monitoring and alerts <!-- task-id: 775a7427ab8b803c3b5f741e2943a6a4 -->
- [ ] Implement rollback plan <!-- task-id: 9e7942cbf54ef337430389035bbec552 -->
- [ ] 48-hour monitoring period <!-- task-id: b87bccf818a82c37efb68dc7c5a24c53 -->

#### Week 4: Secondary Services

- [ ] Migrate remaining applications <!-- task-id: ee85241d3e4fb6eee699195a4917b916 -->
- [ ] Move scheduled jobs <!-- task-id: 469081edc4a537176c3e7f33bcc2fc8c -->
- [ ] Configure email services <!-- task-id: f52941e58e31e8649284b4cabbc94d94 -->
- [ ] Migrate file storage <!-- task-id: 73e794f8a196907d62f054eaf9e8155a -->
- [ ] Update all API endpoints <!-- task-id: 9552e7530244759b7908cb334a21b14b -->
- [ ] Update documentation <!-- task-id: 4bbb31b592eeedb99ff294e6a11ec035 -->
- [ ] Team training on new platform <!-- task-id: a7e37d4b0abe56bbe0f661360e00a57d -->

### Phase 4: Optimization & Cleanup (Week 5-6)

**Dates**: September 20 - October 3, 2025

#### Performance Optimization

- [ ] Analyze Railway metrics <!-- task-id: 4b636c1472aa4c5ad575bc898a2a5b49 -->
- [ ] Optimize container sizing <!-- task-id: 84b15be77b5a4e29d34e0492d39794b5 -->
- [ ] Implement caching strategies <!-- task-id: 135b8c37c54cbcd30748fd46229369e2 -->
- [ ] Configure auto-scaling <!-- task-id: c071676ed3524539735ac33cf14c93cb -->
- [ ] Optimize database queries <!-- task-id: 8172bf9af075cf3610aba255606c49fe -->
- [ ] Set up CDN if needed <!-- task-id: 520bbb1152e009e88dcecb616fa1226c -->

#### Heroku Decommissioning

- [ ] Final data backup from Heroku <!-- task-id: 0aa20d0a9958793bb7b59212da3886a2 -->
- [ ] Export all logs for archival <!-- task-id: ba74b40951b8db207b657e77a00f384d -->
- [ ] Update all DNS records <!-- task-id: 7f8bc55594a803f0971e52be186e9769 -->
- [ ] Cancel Heroku add-ons <!-- task-id: 1878aa0233159ba520a87e64dd9cb881 -->
- [ ] Downgrade to free tier (keep for 30 days) <!-- task-id: 975a9d21f14407f74b07f53369e6ea7a -->
- [ ] Document lessons learned <!-- task-id: 8c655deb24f2e433465ca9f0f7992e6b -->
- [ ] Complete cost analysis <!-- task-id: b2c71c9660a67e7190435257d7aea9e3 -->

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

# Pre-Deployment Checklist

**Project**: CheckmateX Worker v2.0
**Date**: December 5, 2025
**Deployer**: _____________

---

## 1. Code Quality ✅

- [x] All TypeScript files compile without errors
- [x] Type checking passes (`npm run type-check`)
- [x] All phases (1-5) completed
- [ ] Code reviewed and approved
- [ ] No TODOs or FIXMEs in critical paths

## 2. Testing ✅

- [x] Load test script created (`tests/load/load-test.js`)
- [x] Security audit checklist created (`tests/security/security-audit.md`)
- [ ] Load tests executed (optional - requires k6)
- [ ] Security audit completed (optional - manual)
- [ ] Manual testing on key endpoints:
  - [ ] Health check
  - [ ] Username availability
  - [ ] Match result processing
  - [ ] Player ratings query

## 3. Configuration ✅

- [x] `wrangler.toml` configured
  - [x] Project name set
  - [x] Durable Objects bindings defined
  - [x] Cron triggers configured (3 jobs)
  - [x] Queue bindings set
  - [x] Production environment configured

- [ ] Firebase Project ID correct (`FIREBASE_PROJECT_ID = "openings-trainer"`)
- [ ] Service account secret ready for upload

## 4. Dependencies ✅

- [x] `package.json` up to date
- [x] All dependencies installed (`npm install`)
- [ ] No critical vulnerabilities (`npm audit`)
- [x] Lock file committed (`package-lock.json`)

## 5. Secrets Management ⚠️

**REQUIRED BEFORE DEPLOYMENT**:

- [ ] Firebase Service Account secret set:
  ```bash
  wrangler secret put FIREBASE_SERVICE_ACCOUNT --env production
  ```

- [ ] (Optional) Alert webhook set:
  ```bash
  wrangler secret put ALERT_WEBHOOK_URL --env production
  ```

## 6. Documentation ✅

- [x] DEPLOYMENT.md created
- [x] PHASE1_COMPLETE.md exists
- [x] PHASE2_COMPLETE.md exists
- [x] PHASE3_COMPLETE.md exists
- [x] PHASE4_COMPLETE.md exists
- [x] PHASE5_COMPLETE.md exists
- [ ] PHASE6_COMPLETE.md created (after deployment)
- [x] README.md updated

## 7. Monitoring Setup ✅

- [x] Monitoring utilities created (`src/utils/monitoring.ts`)
- [x] Structured logging implemented
- [x] Metrics tracking implemented
- [x] Alert system implemented
- [ ] Cloudflare Analytics enabled (automatic)

## 8. Rollback Plan ✅

- [x] Rollback procedure documented (DEPLOYMENT.md)
- [x] Previous deployment IDs tracked
- [x] Emergency kill switch procedure defined

---

## Pre-Deployment Commands

Run these commands before deploying:

```bash
# 1. Navigate to worker directory
cd checkmatex-worker

# 2. Install dependencies
npm install

# 3. Type check
npm run type-check

# 4. (Optional) Run tests
npm test

# 5. (Optional) Check for vulnerabilities
npm audit
```

---

## Deployment Commands

### Option 1: Deploy to Production Directly

```bash
npm run deploy:production
```

### Option 2: Deploy to Staging First (Recommended)

```bash
# Deploy to staging
npm run deploy:staging

# Test staging
curl https://checkmatex-worker-staging.YOUR_SUBDOMAIN.workers.dev/health

# If successful, deploy to production
npm run deploy:production
```

---

## Post-Deployment Verification

Immediately after deployment:

```bash
# 1. Health check
curl https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/health

# 2. Monitor logs
wrangler tail --env production

# 3. Check Cloudflare Dashboard
# https://dash.cloudflare.com → Workers & Pages → checkmatex-worker-production
```

---

## Critical Success Criteria

Deployment is successful if:

- [x] Worker deploys without errors
- [ ] Health endpoint returns `{"status": "ok"}`
- [ ] No 5xx errors in first 5 minutes
- [ ] Durable Objects accessible
- [ ] Firestore connectivity working
- [ ] Cron jobs scheduled (visible in Cloudflare dashboard)

---

## Rollback Conditions

Rollback immediately if:

- Error rate > 5% for 5 consecutive minutes
- P95 latency > 500ms sustained
- Critical bug reported
- Data corruption detected
- Firestore authentication failures

**Rollback Command**:
```bash
wrangler rollback --deployment-id <PREVIOUS_ID> --env production
```

---

## Sign-Off

**Pre-Deployment Review**:

- [ ] All critical items checked
- [ ] Secrets configured
- [ ] Monitoring ready
- [ ] Rollback plan understood

**Approved By**: _____________
**Date**: _____________
**Time**: _____________

---

## Deployment Log

**Deployment Started**: _____________
**Deployment Completed**: _____________
**Deployment ID**: _____________
**Status**: ☐ Success ☐ Rolled Back ☐ In Progress

**Notes**:
_____________________________________________________________
_____________________________________________________________
_____________________________________________________________

---

**Ready to Deploy**: ☐ Yes ☐ No (address missing items first)

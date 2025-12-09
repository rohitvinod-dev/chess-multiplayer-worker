# CheckmateX Worker Deployment Guide

**Version**: 2.0
**Last Updated**: December 5, 2025

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Deployment Steps](#deployment-steps)
3. [Post-Deployment Verification](#post-deployment-verification)
4. [Rollback Procedure](#rollback-procedure)
5. [Monitoring & Alerts](#monitoring--alerts)

---

## Pre-Deployment Checklist

### 1. Code Quality

- [ ] All tests passing (`npm test`)
- [ ] Type checking passes (`npm run type-check`)
- [ ] No critical security vulnerabilities (`npm audit`)
- [ ] Code reviewed and approved
- [ ] All PHASE*.md files marked as complete

### 2. Configuration

- [ ] `wrangler.toml` configured correctly
  - [ ] Correct project name
  - [ ] Durable Objects bindings set
  - [ ] Cron triggers configured
  - [ ] Queue bindings set
  - [ ] Environment variables set

- [ ] Secrets configured in Cloudflare
  ```bash
  wrangler secret list --env production
  ```
  - [ ] `FIREBASE_SERVICE_ACCOUNT` set
  - [ ] `ALERT_WEBHOOK_URL` set (optional)

### 3. Firebase Setup

- [ ] Service account key generated
- [ ] Firestore database created
- [ ] Security rules configured
- [ ] Firebase project ID matches `wrangler.toml`

### 4. Testing

- [ ] Load tests completed (`k6 run tests/load/load-test.js`)
- [ ] Security audit completed (`tests/security/security-audit.md`)
- [ ] Manual testing on staging environment
- [ ] All critical paths tested:
  - [ ] Health check
  - [ ] User authentication
  - [ ] Match result processing
  - [ ] Progress tracking
  - [ ] Notifications

---

## Deployment Steps

### Step 1: Deploy to Staging

```bash
# Navigate to worker directory
cd checkmatex-worker

# Install dependencies (if not already done)
npm install

# Type check
npm run type-check

# Deploy to staging
npm run deploy:staging
```

**Verify staging deployment**:
```bash
# Health check
curl https://checkmatex-worker-staging.YOUR_SUBDOMAIN.workers.dev/health

# Should return:
# {
#   "status": "ok",
#   "timestamp": 1733400000000,
#   "environment": "staging"
# }
```

### Step 2: Test Staging Environment

Run smoke tests on staging:

```bash
# Test username availability
curl "https://checkmatex-worker-staging.YOUR_SUBDOMAIN.workers.dev/api/users/username/check?username=testuser"

# Test match result (requires valid data)
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "matchId": "test_match_123",
    "whitePlayerId": "player1",
    "blackPlayerId": "player2",
    "winner": "white",
    "moves": ["e4", "e5"],
    "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "duration": 300
  }' \
  https://checkmatex-worker-staging.YOUR_SUBDOMAIN.workers.dev/api/multiplayer/match-result
```

**Monitor staging logs**:
```bash
wrangler tail --env staging
```

### Step 3: Deploy to Production

Once staging is verified:

```bash
# Deploy to production
npm run deploy:production

# Or use wrangler directly
wrangler deploy --env production
```

**Expected output**:
```
⛅️ wrangler 4.21.0
-------------------
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded checkmatex-worker (X.XX sec)
Published checkmatex-worker-production (X.XX sec)
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
```

### Step 4: Verify Production Deployment

```bash
# Health check
curl https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/health

# Verify environment
# Response should show "environment": "production"
```

---

## Post-Deployment Verification

### 1. Immediate Checks (0-5 minutes)

- [ ] Health endpoint responding
- [ ] No 5xx errors in logs
- [ ] Durable Objects working
- [ ] Firestore connectivity working

**Monitor logs**:
```bash
wrangler tail --env production
```

### 2. Short-term Monitoring (5-30 minutes)

- [ ] Error rate < 1%
- [ ] P95 latency < 200ms
- [ ] All cron jobs executing on schedule
- [ ] Notifications being sent

**Check Cloudflare Dashboard**:
1. Go to https://dash.cloudflare.com
2. Navigate to Workers & Pages → checkmatex-worker-production
3. Check Analytics tab:
   - Requests per second
   - Error rate
   - CPU time
   - Durable Object requests

### 3. Long-term Monitoring (24 hours)

- [ ] No memory leaks
- [ ] Consistent performance
- [ ] User feedback positive
- [ ] No critical bugs reported

---

## Rollback Procedure

### When to Rollback

Rollback immediately if:
- Error rate > 5% for 5 consecutive minutes
- P95 latency > 500ms sustained
- Critical bug affecting users
- Data corruption detected

### Rollback Steps

#### Option 1: Rollback to Previous Deployment

```bash
# List recent deployments
wrangler deployments list --env production

# Rollback to previous deployment ID
wrangler rollback --deployment-id <DEPLOYMENT_ID> --env production
```

#### Option 2: Redeploy Previous Version

```bash
# Checkout previous git commit
git log --oneline -10  # Find previous stable commit
git checkout <COMMIT_HASH>

# Deploy previous version
npm run deploy:production

# Return to latest commit
git checkout main
```

#### Option 3: Emergency Kill Switch

If worker is causing critical issues:

```bash
# Deploy minimal worker with only health endpoint
# Create emergency-worker.ts with basic health check only
# Deploy emergency version

wrangler deploy --env production
```

### Post-Rollback Actions

1. **Investigate Root Cause**
   - Review error logs
   - Check changed files
   - Identify problematic code

2. **Fix Issues**
   - Create bugfix branch
   - Fix and test thoroughly
   - Deploy to staging first

3. **Redeploy**
   - Once fixed, redeploy to production
   - Monitor closely

---

## Monitoring & Alerts

### Cloudflare Dashboard Metrics

Monitor these key metrics:

1. **Requests**
   - Total requests per second
   - Success rate (2xx/3xx responses)
   - Error rate (4xx/5xx responses)

2. **Performance**
   - CPU time (ms per request)
   - Wall time (ms per request)
   - P50, P95, P99 latencies

3. **Durable Objects**
   - Active instances
   - Requests per object
   - Object creation rate

### Alert Configuration

**Discord/Slack Webhooks** (optional):

Set up alerts for:
- Error rate > 5%
- P95 latency > 500ms
- Health check failures
- Cron job failures

```bash
# Set webhook URL as secret
wrangler secret put ALERT_WEBHOOK_URL --env production
# Paste your Discord/Slack webhook URL when prompted
```

### Log Analysis

**View real-time logs**:
```bash
wrangler tail --env production
```

**Filter for errors only**:
```bash
wrangler tail --env production --status error
```

**Search logs**:
```bash
wrangler tail --env production | grep "error"
```

---

## Gradual Rollout (Optional)

For major releases, use gradual rollout:

### Week 1: 20% Traffic

Update Flutter app to route 20% of traffic to worker:

```dart
// lib/config/api_config.dart
static bool shouldUseWorker() {
  return Random().nextDouble() < 0.2; // 20%
}
```

Monitor for 7 days, verify:
- Error rate < 1%
- Performance acceptable
- No user complaints

### Week 2: 50% Traffic

```dart
static bool shouldUseWorker() {
  return Random().nextDouble() < 0.5; // 50%
}
```

### Week 3: 100% Traffic

```dart
static bool shouldUseWorker() {
  return true; // 100%
}
```

---

## Emergency Contacts

**On-Call Engineer**: _____________
**Phone**: _____________
**Email**: _____________

**Escalation**:
1. Check Cloudflare Status: https://www.cloudflarestatus.com/
2. Check Firebase Status: https://status.firebase.google.com/
3. Contact Cloudflare Support: https://dash.cloudflare.com/?to=/:account/support

---

## Post-Migration Cleanup

After 2 weeks of 100% traffic:

- [ ] Archive Firebase Functions code
- [ ] Update documentation
- [ ] Remove old dependencies
- [ ] Celebrate! 🎉

---

## Troubleshooting

### Common Issues

**Issue**: "Error: No such namespace: GAME_ROOM"
**Solution**: Run migrations with `wrangler deploy --env production`

**Issue**: "Firebase authentication failed"
**Solution**: Verify `FIREBASE_SERVICE_ACCOUNT` secret is set correctly

**Issue**: "Cron jobs not running"
**Solution**: Check `[triggers]` section in `wrangler.toml`

**Issue**: "High latency"
**Solution**:
1. Check Durable Object performance
2. Optimize Firestore queries
3. Enable caching where possible

---

**Deployment Checklist Complete**: ☐

**Deployed By**: _____________
**Date**: _____________
**Deployment ID**: _____________
**Status**: ☐ Success ☐ Rolled Back

---

**Questions?** Check the implementation.md file or contact the on-call engineer.

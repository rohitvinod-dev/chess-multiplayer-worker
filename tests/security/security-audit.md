# Security Audit Checklist - CheckmateX Worker

**Date**: December 5, 2025
**Version**: 2.0
**Auditor**: _____________
**Status**: Pending

---

## 1. Authentication & Authorization

### Firebase Auth Token Verification

- [ ] **JWT Signature Validation**
  - Verify tokens are signed with correct Firebase public keys
  - Test with expired tokens (should reject with 401)
  - Test with malformed tokens (should reject with 401)
  - Test with tokens from wrong project (should reject with 401)

- [ ] **Token Claims Validation**
  - Verify `iss` claim matches Firebase issuer
  - Verify `aud` claim matches project ID
  - Verify `exp` claim is checked (expiration)
  - Verify `sub` claim (user ID) is present

- [ ] **Public Key Caching**
  - Verify keys are cached (check cache hit rate)
  - Verify keys refresh on rotation
  - Verify cache TTL is reasonable (1 hour)

**Test Commands**:
```bash
# Valid token
curl -H "Authorization: Bearer <VALID_TOKEN>" \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/progress/record

# Expired token
curl -H "Authorization: Bearer <EXPIRED_TOKEN>" \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/progress/record

# Malformed token
curl -H "Authorization: Bearer invalid-token" \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/progress/record
```

---

## 2. Input Validation

### Request Body Validation

- [ ] **Zod Schema Validation**
  - All endpoints use Zod for validation
  - Invalid JSON is rejected
  - Missing required fields are rejected
  - Extra fields are stripped

- [ ] **SQL Injection Prevention**
  - All Firestore queries use parameterized queries
  - No string concatenation in queries
  - User input is sanitized

- [ ] **XSS Prevention**
  - User-generated content is escaped
  - No `eval()` or `Function()` calls
  - CSP headers are set

**Test Commands**:
```bash
# Missing required fields
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"invalid": "data"}' \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/progress/record

# SQL injection attempt
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"matchId": "1; DROP TABLE users;--"}' \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/multiplayer/match-result
```

---

## 3. Secrets Management

### Environment Variables

- [ ] **Firebase Service Account**
  - Stored as Cloudflare secret (not in wrangler.toml)
  - Not logged or exposed in errors
  - Not returned in API responses

- [ ] **Secret Rotation**
  - Document secret rotation procedure
  - Test secret rotation process
  - Verify no downtime during rotation

**Test Commands**:
```bash
# Check secrets are not exposed
curl https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/health
# Response should NOT contain FIREBASE_SERVICE_ACCOUNT

# Verify secret is set
wrangler secret list
```

---

## 4. Rate Limiting & Abuse Prevention

### Endpoint Rate Limiting

- [ ] **Expensive Endpoints Protected**
  - `/api/progress/record` - limit 100 req/min per user
  - `/api/multiplayer/match-result` - limit 10 req/min per match
  - `/api/notifications/enqueue` - limit 20 req/min per user

- [ ] **DDoS Protection**
  - Cloudflare's built-in DDoS protection enabled
  - Rate limiting at edge (Cloudflare)
  - Abuse patterns detected and blocked

**Manual Tests**:
- Send 150 requests to `/api/progress/record` in 1 minute
- Verify 429 Too Many Requests after limit

---

## 5. CORS Configuration

### Cross-Origin Resource Sharing

- [ ] **Allowed Origins**
  - Only Flutter app domains allowed
  - Wildcards (`*`) only in development
  - Preflight requests handled correctly

- [ ] **Allowed Methods**
  - GET, POST, PUT, DELETE only
  - OPTIONS for preflight

- [ ] **Allowed Headers**
  - `Content-Type`
  - `Authorization`
  - Custom headers documented

**Test Commands**:
```bash
# CORS preflight
curl -X OPTIONS \
  -H "Origin: https://malicious-site.com" \
  -H "Access-Control-Request-Method: POST" \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/progress/record

# Verify malicious origin is rejected
```

---

## 6. Data Privacy & GDPR Compliance

### User Data Handling

- [ ] **Data Minimization**
  - Only collect necessary data
  - No PII in logs
  - User IDs are hashed/anonymized in analytics

- [ ] **Right to Deletion**
  - User data can be deleted on request
  - Cascade deletes implemented
  - Leaderboard cleanup removes deleted users

- [ ] **Data Encryption**
  - Data in transit: HTTPS/TLS 1.3
  - Data at rest: Firestore encryption
  - Durable Object storage encrypted

---

## 7. Error Handling & Information Disclosure

### Error Messages

- [ ] **No Sensitive Info in Errors**
  - Stack traces not exposed in production
  - Error messages are generic
  - Detailed errors only in logs

- [ ] **Proper HTTP Status Codes**
  - 401 for unauthorized
  - 403 for forbidden
  - 404 for not found
  - 500 for server errors

**Test Commands**:
```bash
# Trigger error and check response
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"invalid": "data"}' \
  https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev/api/invalid-endpoint

# Verify no stack trace in response
```

---

## 8. Durable Objects Security

### Access Control

- [ ] **User Isolation**
  - UserProfile DO: Only accessible by owner
  - GameRoom DO: Only accessible by participants
  - NotificationScheduler DO: Only by authenticated users

- [ ] **Data Isolation**
  - Each user has separate DO instance
  - No cross-user data access
  - SQL queries scoped to user

---

## 9. Dependency Security

### NPM Package Audit

- [ ] **Vulnerability Scan**
  - Run `npm audit`
  - No high/critical vulnerabilities
  - All dependencies up to date

- [ ] **Supply Chain Security**
  - Use lock files (`package-lock.json`)
  - Verify package integrity
  - Monitor for compromised packages

**Test Commands**:
```bash
cd checkmatex-worker
npm audit
npm outdated
```

---

## 10. Logging & Monitoring

### Security Logging

- [ ] **Authentication Failures Logged**
  - Invalid tokens logged (without token value)
  - Failed login attempts tracked
  - Suspicious patterns alerted

- [ ] **Audit Trail**
  - User actions logged (CRUD operations)
  - Admin actions logged
  - Logs retained for 90 days

---

## 11. Deployment Security

### CI/CD Pipeline

- [ ] **Secret Injection**
  - Secrets injected at runtime (not in repo)
  - GitHub Actions secrets used
  - Wrangler secrets managed securely

- [ ] **Deployment Approval**
  - Production deploys require approval
  - Automated tests pass before deploy
  - Rollback procedure documented

---

## 12. Compliance Checklist

### Standards & Regulations

- [ ] **OWASP Top 10**
  - A01: Broken Access Control - ✅ Fixed
  - A02: Cryptographic Failures - ✅ Fixed
  - A03: Injection - ✅ Fixed
  - A04: Insecure Design - ✅ Fixed
  - A05: Security Misconfiguration - ✅ Fixed
  - A06: Vulnerable Components - ✅ Fixed
  - A07: Auth Failures - ✅ Fixed
  - A08: Integrity Failures - ✅ Fixed
  - A09: Logging Failures - ✅ Fixed
  - A10: SSRF - ✅ Fixed

- [ ] **GDPR Requirements**
  - Privacy policy updated
  - User consent obtained
  - Data deletion implemented

---

## Sign-Off

**Auditor Signature**: _____________________
**Date**: _____________________
**Next Audit Date**: _____________________

---

## Remediation Actions

| Issue | Severity | Status | Assignee | Due Date |
|-------|----------|--------|----------|----------|
| _None identified_ | - | - | - | - |

---

**Audit Complete**: ☐ Pass ☐ Fail ☐ Conditional Pass

**Notes**:
_____________________________________________________________
_____________________________________________________________

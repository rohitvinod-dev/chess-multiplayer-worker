# Firestore Schema Restoration Migration

This directory contains migration scripts to restore the secure Firestore schema by moving data from global collections to user subcollections.

## Prerequisites

1. **Firebase Service Account Key**
   - Go to Firebase Console → Project Settings → Service Accounts
   - Click "Generate New Private Key"
   - Save the downloaded JSON file as `service-account.json` in this directory
   - **IMPORTANT**: Never commit this file to version control!

2. **Dependencies**
   ```bash
   cd checkmatex-worker
   npm install firebase-admin @types/node tsx
   ```

## Running the Migration

### Dry Run (Recommended First)

Test the migration without making any changes:

```bash
npx tsx migrations/restore-subcollections.ts --dry-run
```

This will show you what would be migrated without actually writing to Firestore.

### Full Migration

Run the actual migration:

```bash
npx tsx migrations/restore-subcollections.ts
```

### Selective Migration

Skip specific migrations if needed:

```bash
# Skip match history migration
npx tsx migrations/restore-subcollections.ts --skip-match-history

# Skip custom openings migration
npx tsx migrations/restore-subcollections.ts --skip-openings

# Skip leaderboards migration
npx tsx migrations/restore-subcollections.ts --skip-leaderboards

# Combine flags
npx tsx migrations/restore-subcollections.ts --skip-match-history --skip-openings
```

## What Gets Migrated

### 1. Match History
- **From**: `matchHistory/{matchId}` (global collection)
- **To**: `users/{uid}/matchHistory/{matchId}` (user subcollection)
- **Changes**:
  - Creates 2 documents per match (one for each player)
  - Adds opponent object with userId, username, rating
  - Converts result to per-player perspective (win/loss/draw)
  - Generates PGN from moves array
  - Restores missing fields: opening, openingId, timeControl, rated, reason, playedAt

### 2. Custom Openings & Variations
- **From**:
  - `custom_openings/{id}` (global)
  - `custom_variations/{id}` (global)
- **To**:
  - `users/{uid}/custom_openings/{id}` (user subcollection)
  - `users/{uid}/custom_openings/{id}/variations/{id}` (nested subcollection)
- **Changes**:
  - Removes `userId` field (redundant with path)
  - Removes `isActive` field (uses hard delete instead)
  - Adds progress tracking: masteryLevel, practiceCount, accuracy

### 3. Leaderboards (All 4 Types)
- **From**:
  - `leaderboards/elo/entries/{uid}`
  - `leaderboards/tactical/entries/{uid}`
  - Legacy `leaderboard/{uid}` collection
- **To**:
  - `leaderboards/elo/players/{uid}`
  - `leaderboards/tactical/players/{uid}`
  - `leaderboards/mastery/players/{uid}` (NEW)
  - `leaderboards/streak/players/{uid}` (NEW)
- **Changes**:
  - Renames: `score` → `eloRating/tacticalRating`
  - Renames: `lastUpdated` → `updatedAt`
  - Adds missing stats fields: wins, losses, draws, totalGames
  - Creates new Mastery and Streak leaderboards from legacy data

## Migration Safety

- **Batch Processing**: Uses Firestore batch writes (max 500 operations per batch)
- **Error Handling**: Skips invalid documents with warnings
- **Non-Destructive**: Original collections are NOT deleted
- **Idempotent**: Can be run multiple times safely (uses `set` operations)

## Post-Migration Steps

1. **Verify Data**
   - Check Firebase Console to ensure data migrated correctly
   - Spot-check a few user accounts in each collection
   - Verify leaderboards show correct data

2. **Test Application**
   - Run Flutter app and test all features
   - Check match history displays correctly
   - Test custom openings CRUD operations
   - Verify leaderboards show proper rankings

3. **Clean Up (Optional)**

   After verifying migration success, you can delete old collections:

   ```bash
   # WARNING: Only do this after thorough verification!
   # These commands are destructive and irreversible

   # Delete old global collections via Firebase Console or scripts:
   # - matchHistory (global collection)
   # - custom_openings (global collection)
   # - custom_variations (global collection)
   # - leaderboards/elo/entries (subcollection)
   # - leaderboards/tactical/entries (subcollection)
   # - leaderboard (legacy collection)
   ```

## Troubleshooting

### "service-account.json not found"
- Download your Firebase service account key from Firebase Console
- Save it in `checkmatex-worker/migrations/service-account.json`

### "Permission denied" errors
- Verify service account has necessary permissions:
  - Cloud Datastore User
  - Firebase Admin SDK Administrator Service Agent

### Migration takes too long
- Use selective migration flags to migrate in phases
- Run during low-traffic hours
- Consider increasing batch size (max 500)

### Duplicate data issues
- Migration is idempotent and uses `set()` operations
- Running multiple times will overwrite with latest data
- Original collections remain untouched

## Rollback

If issues occur after migration:

1. **Keep original collections** - Don't delete them immediately
2. **Update Worker endpoints** - Point back to original collections
3. **Redeploy Firestore rules** - Revert to previous rules version
4. **Monitor** - Check error rates in Cloudflare dashboard

## Support

For issues or questions:
- Check MIGRATION_STATUS.md for detailed migration progress
- Review plan.md for architecture decisions
- Contact development team for critical issues

---

**Created**: December 8, 2025
**Last Updated**: December 8, 2025

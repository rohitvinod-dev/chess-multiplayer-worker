import { authenticateRequest } from './auth';
import { FirestoreClient } from './firestore';
import { handleMatchResult } from './endpoints/multiplayer/match-result';
import { handleRecordProgress } from './endpoints/progress/record';
import { handleClaimEnergyReward } from './endpoints/progress/energy';
import { handlePuzzleTroubleSubmit } from './endpoints/progress/puzzle-trouble';
import { handleEnsureUserProfile } from './endpoints/users/profile';
import { handleRegisterDevice } from './endpoints/users/device';
import { handleDeleteAccount } from './endpoints/users/delete-account';
import { handleEnqueueNotification } from './endpoints/notifications/enqueue';
import { handleUpdateNotificationPreferences } from './endpoints/notifications/preferences';
import { handleTrackNotificationOpened } from './endpoints/notifications/track';
import { handleManageOpenings } from './endpoints/openings/manage';
import { handleSyncAchievements } from './endpoints/achievements/sync';
import { handleMigrateUsernames } from './endpoints/admin/migrate-usernames';
import { handleUpdateOpening } from './endpoints/admin/update-opening';
import { handleSyncRatingsToLeaderboard } from './endpoints/admin/sync-ratings-to-leaderboard';
import { handleMigrateEloModes } from './endpoints/admin/migrate-elo-modes';
import { createLobbyHandler } from './endpoints/lobby/create';
import { listLobbiesHandler } from './endpoints/lobby/list';
import { joinLobbyHandler } from './endpoints/lobby/join';
import { spectateLobbyHandler } from './endpoints/lobby/spectate';
import { deleteLobbyHandler } from './endpoints/lobby/delete';

// Queue-based cron jobs (SCALABLE - supports millions of users!)
import { enqueueLeaderboardCleanup, processCleanupBatch } from './cron/cleanup-leaderboards-queue';
import { enqueueStreakReminders, processRemindersBatch } from './cron/daily-reminders-queue';
import { enqueueLastChanceReminders, processLastChanceBatch } from './cron/last-chance-queue';
// Direct processing cron jobs (FREE PLAN - works without queues!)
import { sendStreakRemindersDirectly, sendLastChanceRemindersDirectly, cleanupLeaderboardsDirectly } from './cron/direct-reminders';
// Win-back and weekly summary cron jobs
import { sendWinBackNotifications } from './cron/win-back-notifications';
import { sendWeeklyProgressSummaries } from './cron/weekly-progress-summary';
import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";
import type { ChatMessage, Message, GameMode, ChatRole, MessageReaction } from "./shared";
import { ALLOWED_REACTION_EMOJIS } from "./shared";

// Export Durable Objects
export { GameRoom } from './durable-objects/game-room';
export { UserProfile } from './durable-objects/user-profile';
export { LobbyList } from './durable-objects/lobby-list';
export { LobbyRoom } from './durable-objects/lobby-room';

// Environment interface
export interface Env {
  // Durable Objects
  GAME_ROOM: DurableObjectNamespace;
  CHAT: DurableObjectNamespace;
  MATCHMAKING_QUEUE: DurableObjectNamespace;
  STATS_TRACKER: DurableObjectNamespace;
  USER_PROFILE: DurableObjectNamespace;
  NOTIFICATION_SCHEDULER: DurableObjectNamespace;
  LOBBY_LIST: DurableObjectNamespace;
  LOBBY_ROOM: DurableObjectNamespace;

  // Secrets & Environment Variables
  FIREBASE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
  ENVIRONMENT: string;

  // Cloudflare Queues (Phase 5 - Scalable Cron Jobs)
  CLEANUP_QUEUE: Queue;
  REMINDERS_QUEUE: Queue;
  LAST_CHANCE_QUEUE: Queue;

  // Assets (static files)
  ASSETS: Fetcher;
}

// ============ CHAT ROOM (from old index.ts) ============
const MAX_MESSAGES = 100; // Keep only the most recent 100 messages

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  messages = [] as ChatMessage[];
  pinnedMessages = [] as ChatMessage[];
  
  // Cache for admin/moderator status (userId -> role)
  private adminCache = new Map<string, { role: ChatRole; expiresAt: number }>();
  private static readonly ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  broadcastMessage(message: Message, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  onStart() {
    // Create messages table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        user TEXT NOT NULL,
        userId TEXT NOT NULL DEFAULT '',
        displayName TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        timestamp INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      )
    `);

    // Create banned_users table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS banned_users (
        oderId TEXT PRIMARY KEY,
        oderedBy TEXT NOT NULL,
        displayName TEXT NOT NULL DEFAULT '',
        reason TEXT,
        bannedAt INTEGER NOT NULL,
        expiresAt INTEGER,
        type TEXT NOT NULL DEFAULT 'ban'
      )
    `);

    // Create pinned_messages table with full message content for persistence
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        messageId TEXT PRIMARY KEY,
        pinnedBy TEXT NOT NULL,
        pinnedAt INTEGER NOT NULL,
        content TEXT,
        userId TEXT,
        displayName TEXT,
        role TEXT,
        timestamp INTEGER,
        metadata TEXT
      )
    `);

    // Create reactions table for message reactions
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        messageId TEXT NOT NULL,
        emoji TEXT NOT NULL,
        userId TEXT NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (messageId, emoji, userId)
      )
    `);
    // Migrate pinned_messages to include content columns
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN content TEXT`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN userId TEXT`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN displayName TEXT`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN role TEXT`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN timestamp INTEGER`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE pinned_messages ADD COLUMN metadata TEXT`);
    } catch { /* column exists */ }

    // Migrate messages table columns
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN userId TEXT NOT NULL DEFAULT ''`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN displayName TEXT NOT NULL DEFAULT ''`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN timestamp INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`);
    } catch { /* column exists */ }

    // Cleanup expired bans/mutes
    const now = Date.now();
    this.ctx.storage.sql.exec(`DELETE FROM banned_users WHERE expiresAt IS NOT NULL AND expiresAt < ${now}`);

    // Load messages
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT ${MAX_MESSAGES}`)
      .toArray();

    this.messages = rows.reverse().map((row: Record<string, unknown>) => ({
      id: String(row.id || ''),
      content: String(row.content || ''),
      user: String(row.user || row.displayName || ''),
      userId: String(row.userId || ''),
      displayName: String(row.displayName || row.user || ''),
      role: (row.role as ChatMessage['role']) || 'user',
      timestamp: Number(row.timestamp) || 0,
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
    }));

    // Load reactions for all messages
    this.loadReactionsForMessages();

    // Load pinned messages (from pinned_messages table which stores full content)
    const pinnedRows = this.ctx.storage.sql
      .exec(`SELECT * FROM pinned_messages ORDER BY pinnedAt DESC LIMIT 1`)
      .toArray();

    this.pinnedMessages = pinnedRows.map((row: Record<string, unknown>) => {
      // Parse stored metadata or create new
      let metadata: Record<string, unknown> = {};
      if (row.metadata) {
        try {
          metadata = JSON.parse(String(row.metadata));
        } catch { /* ignore parse errors */ }
      }
      
      return {
        id: String(row.messageId || ''),
        content: String(row.content || ''),
        user: String(row.displayName || ''),
        userId: String(row.userId || ''),
        displayName: String(row.displayName || ''),
        role: (row.role as ChatMessage['role']) || 'user',
        timestamp: Number(row.timestamp) || 0,
        metadata: {
          ...metadata,
          isPinned: true,
          pinnedAt: Number(row.pinnedAt) || 0,
          pinnedBy: String(row.pinnedBy || ''),
        },
      };
    });
  }

  onConnect(connection: Connection) {
    // Get user's ban/mute status from connection URL params
    const url = new URL(connection.url || 'http://localhost');
    const oderId = url.searchParams.get('userId') || '';
    const banStatus = this.getUserBanStatus(oderId);

    // Delta sync: check for 'since' parameter (timestamp of client's newest cached message)
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam ? parseInt(sinceParam, 10) : null;

    let messagesToSend: ChatMessage[];
    let hasMore = false;

    if (since && !isNaN(since) && since > 0) {
      // Delta sync: send only messages newer than 'since'
      const newerMessages = this.messages.filter((m) => m.timestamp > since);

      // If there are too many new messages (>100), fall back to sending last 50
      if (newerMessages.length > 100) {
        messagesToSend = this.messages.slice(-50);
        hasMore = this.messages.length > 50;
      } else {
        messagesToSend = newerMessages;
        // hasMore is true if there are messages older than what we're sending
        hasMore = this.messages.length > newerMessages.length;
      }
    } else {
      // No delta sync: send most recent 50 messages
      messagesToSend = this.messages.slice(-50);
      hasMore = this.messages.length > 50;
    }

    connection.send(
      JSON.stringify({
        type: "init",
        messages: messagesToSend,
        pinnedMessages: this.pinnedMessages,
        userBanStatus: banStatus,
        hasMore,
      } satisfies Message),
    );
  }

  /**
   * Get ban/mute status for a user
   */
  private getUserBanStatus(oderId: string): { isBanned: boolean; isMuted: boolean; expiresAt?: number; reason?: string } {
    if (!oderId) return { isBanned: false, isMuted: false };

    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM banned_users WHERE oderId = '${this.escapeSQL(oderId)}' 
             AND (expiresAt IS NULL OR expiresAt > ${now})`)
      .toArray();

    if (rows.length === 0) {
      return { isBanned: false, isMuted: false };
    }

    const row = rows[0] as Record<string, unknown>;
    const type = String(row.type || 'ban');
    
    return {
      isBanned: type === 'ban',
      isMuted: type === 'mute',
      expiresAt: row.expiresAt ? Number(row.expiresAt) : undefined,
      reason: row.reason ? String(row.reason) : undefined,
    };
  }

  /**
   * Check if user is banned or muted
   */
  private isUserRestricted(oderId: string): { restricted: boolean; type?: 'ban' | 'mute'; reason?: string } {
    const status = this.getUserBanStatus(oderId);
    if (status.isBanned) {
      return { restricted: true, type: 'ban', reason: status.reason };
    }
    if (status.isMuted) {
      return { restricted: true, type: 'mute', reason: status.reason };
    }
    return { restricted: false };
  }

  /**
   * Validate user's role against Firestore admin_users collection.
   */
  private async validateRole(oderId: string, claimedRole: ChatRole): Promise<ChatRole> {
    console.log(`Chat: validateRole called - userId: ${oderId}, claimedRole: ${claimedRole}`);
    
    if (claimedRole === 'user' || claimedRole === 'system') {
      return claimedRole;
    }

    const cached = this.adminCache.get(oderId);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`Chat: Using cached role for ${oderId}: ${cached.role}`);
      if (cached.role === 'admin') return claimedRole;
      if (cached.role === 'moderator' && claimedRole === 'moderator') return 'moderator';
      return 'user';
    }

    try {
      const projectId = this.env.FIREBASE_PROJECT_ID;
      console.log(`Chat: Fetching admin status from Firestore for project: ${projectId}`);
      const serviceAccount = JSON.parse(this.env.FIREBASE_SERVICE_ACCOUNT);
      const token = await this.getFirestoreAccessToken(serviceAccount);
      
      const adminDocUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admin_users/${oderId}`;
      console.log(`Chat: Fetching from: ${adminDocUrl}`);
      const response = await fetch(adminDocUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      console.log(`Chat: Firestore response status: ${response.status}`);

      if (response.ok) {
        const doc = await response.json() as { fields?: { isAdmin?: { booleanValue?: boolean }; role?: { stringValue?: string } } };
        console.log(`Chat: Firestore doc fields:`, JSON.stringify(doc.fields));
        
        if (doc.fields?.isAdmin?.booleanValue === true) {
          const storedRole = doc.fields?.role?.stringValue as ChatRole || 'admin';
          const validRole = storedRole === 'admin' || storedRole === 'moderator' ? storedRole : 'admin';
          
          this.adminCache.set(oderId, { role: validRole, expiresAt: Date.now() + Chat.ADMIN_CACHE_TTL });
          console.log(`Chat: User ${oderId} validated as ${validRole}`);
          return claimedRole === 'admin' && validRole === 'admin' ? 'admin' : 
                 (validRole === 'admin' || validRole === 'moderator') ? validRole : 'user';
        } else {
          console.log(`Chat: isAdmin field not true for ${oderId}`);
        }
      } else {
        const errorText = await response.text();
        console.log(`Chat: Firestore error response: ${errorText}`);
      }

      this.adminCache.set(oderId, { role: 'user', expiresAt: Date.now() + Chat.ADMIN_CACHE_TTL });
      console.log(`Chat: User ${oderId} set to 'user' role (not admin)`);
      return 'user';
    } catch (error) {
      console.error(`Chat: Error validating role for ${oderId}:`, error);
      return 'user';
    }
  }

  /**
   * Check if user has admin or moderator privileges
   */
  private async isAdminOrModerator(oderId: string): Promise<boolean> {
    const role = await this.validateRole(oderId, 'admin');
    return role === 'admin' || role === 'moderator';
  }

  /**
   * Check if user is admin (not just moderator)
   */
  private async isAdmin(oderId: string): Promise<boolean> {
    const role = await this.validateRole(oderId, 'admin');
    return role === 'admin';
  }

  private async getFirestoreAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    };

    const encoder = new TextEncoder();
    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signatureInput = `${headerB64}.${payloadB64}`;

    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pemContents = serviceAccount.private_key.replace(pemHeader, '').replace(pemFooter, '').replace(/\s/g, '');
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );

    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(signatureInput));
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = `${signatureInput}.${signatureB64}`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const tokenData = await tokenResponse.json() as { access_token: string };
    return tokenData.access_token;
  }

  // ===== MESSAGE MANAGEMENT =====

  saveMessage(message: ChatMessage) {
    const existingIndex = this.messages.findIndex((m) => m.id === message.id);

    if (existingIndex >= 0) {
      this.messages[existingIndex] = message;
    } else {
      this.messages.push(message);
      if (this.messages.length > MAX_MESSAGES) {
        const toDelete = this.messages.splice(0, this.messages.length - MAX_MESSAGES);
        for (const msg of toDelete) {
          this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = '${this.escapeSQL(msg.id)}'`);
          // Note: We do NOT delete from pinned_messages - pinned messages persist beyond the 100 message limit
          // They are stored with full content and only deleted on explicit unpin
        }
      }
    }

    const escapedId = this.escapeSQL(message.id);
    const escapedContent = this.escapeSQL(message.content);
    const escapedUser = this.escapeSQL(message.user || message.displayName);
    const escapedUserId = this.escapeSQL(message.userId || '');
    const escapedDisplayName = this.escapeSQL(message.displayName || message.user);
    const escapedRole = this.escapeSQL(message.role || 'user');
    const timestamp = message.timestamp || Date.now();
    const metadataJson = message.metadata ? this.escapeSQL(JSON.stringify(message.metadata)) : null;

    this.ctx.storage.sql.exec(`
      INSERT INTO messages (id, content, user, userId, displayName, role, timestamp, metadata)
      VALUES ('${escapedId}', '${escapedContent}', '${escapedUser}', '${escapedUserId}',
              '${escapedDisplayName}', '${escapedRole}', ${timestamp}, ${metadataJson ? `'${metadataJson}'` : 'NULL'})
      ON CONFLICT (id) DO UPDATE SET content = '${escapedContent}', metadata = ${metadataJson ? `'${metadataJson}'` : 'NULL'}
    `);
  }

  deleteMessage(messageId: string) {
    this.messages = this.messages.filter((m) => m.id !== messageId);
    this.pinnedMessages = this.pinnedMessages.filter((m) => m.id !== messageId);
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = '${this.escapeSQL(messageId)}'`);
    this.ctx.storage.sql.exec(`DELETE FROM pinned_messages WHERE messageId = '${this.escapeSQL(messageId)}'`);
  }

  // ===== ADMIN ACTIONS =====

  private async handleAdminDelete(adminUserId: string, messageId: string): Promise<void> {
    console.log(`Chat: handleAdminDelete called - adminUserId: ${adminUserId}, messageId: ${messageId}`);
    const isAuthorized = await this.isAdminOrModerator(adminUserId);
    console.log(`Chat: isAdminOrModerator result: ${isAuthorized}`);
    
    if (!isAuthorized) {
      console.log(`Chat: User ${adminUserId} not authorized to delete messages`);
      // Send error back to the user
      this.broadcast(JSON.stringify({ 
        type: 'error', 
        message: 'Not authorized to delete messages',
        userId: adminUserId 
      }));
      return;
    }

    this.deleteMessage(messageId);
    this.broadcast(JSON.stringify({ type: 'delete', id: messageId, deletedBy: adminUserId }));
    console.log(`Chat: Admin ${adminUserId} deleted message ${messageId}`);
  }

  private async handleBan(adminUserId: string, targetUserId: string, reason?: string, durationMinutes?: number): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to ban users`);
      return;
    }

    // Get target user display name from recent messages
    const targetMessage = this.messages.find(m => m.userId === targetUserId);
    const displayName = targetMessage?.displayName || 'Unknown';

    const bannedAt = Date.now();
    const expiresAt = durationMinutes ? bannedAt + (durationMinutes * 60 * 1000) : null;

    this.ctx.storage.sql.exec(`
      INSERT INTO banned_users (oderId, oderedBy, displayName, reason, bannedAt, expiresAt, type)
      VALUES ('${this.escapeSQL(targetUserId)}', '${this.escapeSQL(adminUserId)}', '${this.escapeSQL(displayName)}',
              ${reason ? `'${this.escapeSQL(reason)}'` : 'NULL'}, ${bannedAt}, ${expiresAt || 'NULL'}, 'ban')
      ON CONFLICT (oderId) DO UPDATE SET 
        oderedBy = '${this.escapeSQL(adminUserId)}', reason = ${reason ? `'${this.escapeSQL(reason)}'` : 'NULL'},
        bannedAt = ${bannedAt}, expiresAt = ${expiresAt || 'NULL'}, type = 'ban'
    `);

    this.broadcast(JSON.stringify({
      type: 'user_banned',
      targetUserId,
      targetDisplayName: displayName,
      reason,
      expiresAt: expiresAt || undefined,
      bannedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} banned user ${targetUserId} (${displayName})`);
  }

  private async handleUnban(adminUserId: string, targetUserId: string): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to unban users`);
      return;
    }

    this.ctx.storage.sql.exec(`DELETE FROM banned_users WHERE oderId = '${this.escapeSQL(targetUserId)}'`);

    this.broadcast(JSON.stringify({
      type: 'user_unbanned',
      targetUserId,
      unbannedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} unbanned user ${targetUserId}`);
  }

  private async handleMute(adminUserId: string, targetUserId: string, reason?: string, durationMinutes?: number): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to mute users`);
      return;
    }

    const targetMessage = this.messages.find(m => m.userId === targetUserId);
    const displayName = targetMessage?.displayName || 'Unknown';

    const mutedAt = Date.now();
    const expiresAt = durationMinutes ? mutedAt + (durationMinutes * 60 * 1000) : null;

    this.ctx.storage.sql.exec(`
      INSERT INTO banned_users (oderId, oderedBy, displayName, reason, bannedAt, expiresAt, type)
      VALUES ('${this.escapeSQL(targetUserId)}', '${this.escapeSQL(adminUserId)}', '${this.escapeSQL(displayName)}',
              ${reason ? `'${this.escapeSQL(reason)}'` : 'NULL'}, ${mutedAt}, ${expiresAt || 'NULL'}, 'mute')
      ON CONFLICT (oderId) DO UPDATE SET 
        oderedBy = '${this.escapeSQL(adminUserId)}', reason = ${reason ? `'${this.escapeSQL(reason)}'` : 'NULL'},
        bannedAt = ${mutedAt}, expiresAt = ${expiresAt || 'NULL'}, type = 'mute'
    `);

    this.broadcast(JSON.stringify({
      type: 'user_muted',
      targetUserId,
      targetDisplayName: displayName,
      reason,
      expiresAt: expiresAt || undefined,
      mutedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} muted user ${targetUserId} (${displayName})`);
  }

  private async handleUnmute(adminUserId: string, targetUserId: string): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to unmute users`);
      return;
    }

    this.ctx.storage.sql.exec(`DELETE FROM banned_users WHERE oderId = '${this.escapeSQL(targetUserId)}' AND type = 'mute'`);

    this.broadcast(JSON.stringify({
      type: 'user_unmuted',
      targetUserId,
      unmutedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} unmuted user ${targetUserId}`);
  }

  private async handlePin(adminUserId: string, messageId: string): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to pin messages`);
      return;
    }

    const message = this.messages.find(m => m.id === messageId);
    if (!message) {
      console.log(`Chat: Message ${messageId} not found for pinning`);
      return;
    }

    // Only 1 pinned message allowed - unpin existing first
    if (this.pinnedMessages.length > 0) {
      const existingPinned = this.pinnedMessages[0];
      this.ctx.storage.sql.exec(`DELETE FROM pinned_messages WHERE messageId != '${this.escapeSQL(messageId)}'`);
      this.pinnedMessages = [];
      
      // Broadcast unpin for old message
      this.broadcast(JSON.stringify({
        type: 'message_unpinned',
        messageId: existingPinned.id,
        unpinnedBy: adminUserId,
      }));
      console.log(`Chat: Auto-unpinned previous message ${existingPinned.id}`);
    }

    const pinnedAt = Date.now();
    const metadataJson = JSON.stringify({ ...message.metadata, isPinned: true, pinnedAt, pinnedBy: adminUserId });
    
    // Store full message content for persistence beyond 100 message limit
    this.ctx.storage.sql.exec(`
      INSERT INTO pinned_messages (messageId, pinnedBy, pinnedAt, content, userId, displayName, role, timestamp, metadata)
      VALUES (
        '${this.escapeSQL(messageId)}', 
        '${this.escapeSQL(adminUserId)}', 
        ${pinnedAt},
        '${this.escapeSQL(message.content)}',
        '${this.escapeSQL(message.userId)}',
        '${this.escapeSQL(message.displayName)}',
        '${this.escapeSQL(message.role || 'user')}',
        ${message.timestamp},
        '${this.escapeSQL(metadataJson)}'
      )
      ON CONFLICT (messageId) DO UPDATE SET
        pinnedBy = '${this.escapeSQL(adminUserId)}',
        pinnedAt = ${pinnedAt},
        metadata = '${this.escapeSQL(metadataJson)}'
    `);

    const pinnedMessage: ChatMessage = {
      ...message,
      metadata: { ...message.metadata, isPinned: true, pinnedAt, pinnedBy: adminUserId },
    };

    this.pinnedMessages = [pinnedMessage];

    this.broadcast(JSON.stringify({
      type: 'message_pinned',
      message: pinnedMessage,
      pinnedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} pinned message ${messageId}`);
  }

  private async handleUnpin(adminUserId: string, messageId: string): Promise<void> {
    if (!await this.isAdminOrModerator(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to unpin messages`);
      return;
    }

    this.ctx.storage.sql.exec(`DELETE FROM pinned_messages WHERE messageId = '${this.escapeSQL(messageId)}'`);
    this.pinnedMessages = this.pinnedMessages.filter(m => m.id !== messageId);

    this.broadcast(JSON.stringify({
      type: 'message_unpinned',
      messageId,
      unpinnedBy: adminUserId,
    }));

    console.log(`Chat: Admin ${adminUserId} unpinned message ${messageId}`);
  }

  private async handleAnnounce(adminUserId: string, content: string, durationHours?: number): Promise<void> {
    if (!await this.isAdmin(adminUserId)) {
      console.log(`Chat: User ${adminUserId} not authorized to create announcements`);
      return;
    }

    const cached = this.adminCache.get(adminUserId);
    const adminRole = cached?.role || 'admin';

    const announcement: ChatMessage = {
      id: `announce-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      content,
      user: 'System',
      userId: adminUserId,
      displayName: 'Announcement',
      role: 'system',
      timestamp: Date.now(),
      metadata: {
        isAnnouncement: true,
        announcementExpiresAt: durationHours ? Date.now() + (durationHours * 60 * 60 * 1000) : undefined,
      },
    };

    this.saveMessage(announcement);
    this.broadcast(JSON.stringify({ type: 'announcement', message: announcement }));

    console.log(`Chat: Admin ${adminUserId} created announcement`);
  }

  private escapeSQL(value: string): string {
    return value.replace(/'/g, "''");
  }

  // ===== REACTIONS MANAGEMENT =====

  /**
   * Get all reactions for a message
   */
  private getReactionsForMessage(messageId: string): MessageReaction[] {
    const rows = this.ctx.storage.sql
      .exec(`SELECT emoji, userId FROM reactions WHERE messageId = '${this.escapeSQL(messageId)}' ORDER BY emoji, createdAt`)
      .toArray();

    // Group by emoji
    const reactionMap = new Map<string, string[]>();
    for (const row of rows) {
      const emoji = String(row.emoji);
      const userId = String(row.userId);
      if (!reactionMap.has(emoji)) {
        reactionMap.set(emoji, []);
      }
      reactionMap.get(emoji)!.push(userId);
    }

    return Array.from(reactionMap.entries()).map(([emoji, userIds]) => ({
      emoji,
      userIds,
    }));
  }

  /**
   * Load reactions for all messages in cache
   */
  private loadReactionsForMessages(): void {
    for (const message of this.messages) {
      message.reactions = this.getReactionsForMessage(message.id);
    }
  }

  /**
   * Handle adding a reaction to a message
   */
  private handleAddReaction(userId: string, messageId: string, emoji: string): void {
    // Validate emoji is allowed
    if (!ALLOWED_REACTION_EMOJIS.includes(emoji as typeof ALLOWED_REACTION_EMOJIS[number])) {
      console.log(`Chat: Invalid emoji ${emoji} - not in allowed list`);
      return;
    }

    // Check if message exists
    const message = this.messages.find(m => m.id === messageId);
    if (!message) {
      console.log(`Chat: Message ${messageId} not found for reaction`);
      return;
    }

    // Check if user already reacted with this emoji
    const existingRows = this.ctx.storage.sql
      .exec(`SELECT 1 FROM reactions WHERE messageId = '${this.escapeSQL(messageId)}'
             AND emoji = '${this.escapeSQL(emoji)}' AND userId = '${this.escapeSQL(userId)}'`)
      .toArray();

    if (existingRows.length > 0) {
      console.log(`Chat: User ${userId} already reacted with ${emoji} on message ${messageId}`);
      return;
    }

    // Add reaction
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(`
      INSERT INTO reactions (messageId, emoji, userId, createdAt)
      VALUES ('${this.escapeSQL(messageId)}', '${this.escapeSQL(emoji)}', '${this.escapeSQL(userId)}', ${createdAt})
    `);

    // Update in-memory cache
    const reactions = this.getReactionsForMessage(messageId);
    message.reactions = reactions;

    // Broadcast reaction added
    this.broadcast(JSON.stringify({
      type: 'reaction_added',
      messageId,
      emoji,
      userId,
      reactions,
    }));

    console.log(`Chat: User ${userId} added reaction ${emoji} to message ${messageId}`);
  }

  /**
   * Handle removing a reaction from a message
   */
  private handleRemoveReaction(userId: string, messageId: string, emoji: string): void {
    // Remove reaction from DB
    this.ctx.storage.sql.exec(`
      DELETE FROM reactions
      WHERE messageId = '${this.escapeSQL(messageId)}'
        AND emoji = '${this.escapeSQL(emoji)}'
        AND userId = '${this.escapeSQL(userId)}'
    `);

    // Update in-memory cache
    const message = this.messages.find(m => m.id === messageId);
    if (message) {
      const reactions = this.getReactionsForMessage(messageId);
      message.reactions = reactions;

      // Broadcast reaction removed
      this.broadcast(JSON.stringify({
        type: 'reaction_removed',
        messageId,
        emoji,
        userId,
        reactions,
      }));
    }

    console.log(`Chat: User ${userId} removed reaction ${emoji} from message ${messageId}`);
  }

  // ===== PAGINATION =====

  /**
   * Get historical messages with pagination
   */
  private getHistory(before?: number, limit: number = 50): { messages: ChatMessage[]; hasMore: boolean } {
    const actualLimit = Math.min(limit, 100); // Cap at 100 messages per request
    const beforeTimestamp = before || Date.now() + 1;

    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM messages WHERE timestamp < ${beforeTimestamp} ORDER BY timestamp DESC LIMIT ${actualLimit + 1}`)
      .toArray();

    const hasMore = rows.length > actualLimit;
    const messages = rows.slice(0, actualLimit).reverse().map((row: Record<string, unknown>) => {
      const msg: ChatMessage = {
        id: String(row.id || ''),
        content: String(row.content || ''),
        user: String(row.user || row.displayName || ''),
        userId: String(row.userId || ''),
        displayName: String(row.displayName || row.user || ''),
        role: (row.role as ChatMessage['role']) || 'user',
        timestamp: Number(row.timestamp) || 0,
        metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
      };
      // Load reactions for each message
      msg.reactions = this.getReactionsForMessage(msg.id);
      return msg;
    });

    return { messages, hasMore };
  }

  async onMessage(connection: Connection, message: WSMessage) {
    const parsed = JSON.parse(message as string) as Message;

    // Handle reactions
    if (parsed.type === 'add_reaction') {
      this.handleAddReaction(parsed.userId, parsed.messageId, parsed.emoji);
      return;
    }
    if (parsed.type === 'remove_reaction') {
      this.handleRemoveReaction(parsed.userId, parsed.messageId, parsed.emoji);
      return;
    }

    // Handle pagination
    if (parsed.type === 'get_history') {
      const { messages, hasMore } = this.getHistory(parsed.before, parsed.limit);
      connection.send(JSON.stringify({
        type: 'history',
        messages,
        hasMore,
      }));
      return;
    }

    // Handle admin actions
    if (parsed.type === 'admin_delete') {
      await this.handleAdminDelete(parsed.adminUserId, parsed.messageId);
      return;
    }
    if (parsed.type === 'admin_ban') {
      await this.handleBan(parsed.adminUserId, parsed.targetUserId, parsed.reason, parsed.duration);
      return;
    }
    if (parsed.type === 'admin_unban') {
      await this.handleUnban(parsed.adminUserId, parsed.targetUserId);
      return;
    }
    if (parsed.type === 'admin_mute') {
      await this.handleMute(parsed.adminUserId, parsed.targetUserId, parsed.reason, parsed.duration);
      return;
    }
    if (parsed.type === 'admin_unmute') {
      await this.handleUnmute(parsed.adminUserId, parsed.targetUserId);
      return;
    }
    if (parsed.type === 'admin_pin') {
      await this.handlePin(parsed.adminUserId, parsed.messageId);
      return;
    }
    if (parsed.type === 'admin_unpin') {
      await this.handleUnpin(parsed.adminUserId, parsed.messageId);
      return;
    }
    if (parsed.type === 'admin_announce') {
      await this.handleAnnounce(parsed.adminUserId, parsed.content, parsed.duration);
      return;
    }

    if (parsed.type === "add" || parsed.type === "update") {
      // Check if user is banned or muted
      const restriction = this.isUserRestricted(parsed.userId || '');
      if (restriction.restricted) {
        connection.send(JSON.stringify({
          type: 'error',
          code: restriction.type === 'ban' ? 'USER_BANNED' : 'USER_MUTED',
          message: restriction.reason || (restriction.type === 'ban' ? 'You are banned from chat' : 'You are muted'),
        }));
        return;
      }

      const claimedRole = parsed.role || 'user';
      const validatedRole = await this.validateRole(parsed.userId || '', claimedRole);
      
      const msgWithTimestamp: ChatMessage = {
        id: parsed.id,
        content: parsed.content,
        user: parsed.user,
        userId: parsed.userId || '',
        displayName: parsed.displayName || parsed.user,
        role: validatedRole,
        timestamp: parsed.timestamp || Date.now(),
        metadata: parsed.metadata,
      };

      this.saveMessage(msgWithTimestamp);
      this.broadcast(JSON.stringify({ ...parsed, role: validatedRole, timestamp: msgWithTimestamp.timestamp }));
    } else if (parsed.type === "delete") {
      // Regular users can only delete their own messages (handled client-side)
      this.deleteMessage(parsed.id);
      this.broadcast(message);
    } else {
      this.broadcast(message);
    }
  }
}

// ============ MATCHMAKING QUEUE (from old index.ts) ============
const MATCHMAKING_TIMEOUT_SECONDS = 30;

interface QueueEntry {
  playerId: string;
  displayName: string;
  rating: number;
  isProvisional: boolean;
  gameMode: GameMode;
  joinedAt: number;
  minRating: number;
  maxRating: number;
  expiresAt: number;
  origin?: string;
}

interface PendingMatch {
  roomId: string;
  color: string;
  opponentId: string;
  opponentDisplayName: string;
  opponentRating: number;
  accessToken: string;
  webSocketUrl: string;
  createdAt: number;
  expiresAt: number;
}

export class MatchmakingQueue {
  private state: DurableObjectState;
  private env: Env;
  private queue: QueueEntry[] = [];
  private queueLoaded: boolean = false;
  private pendingMatches: Map<string, PendingMatch> = new Map();
  private pendingMatchesLoaded: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.queue = [];
    this.pendingMatches = new Map();
  }

  private async loadQueue(): Promise<void> {
    if (this.queueLoaded) return;

    const stored = await this.state.storage.get<QueueEntry[]>('queue');
    if (stored) {
      const now = Date.now();
      this.queue = stored.filter(entry => entry.expiresAt > now);
    } else {
      this.queue = [];
    }

    this.queueLoaded = true;
    console.log(`MatchmakingQueue: Loaded ${this.queue.length} entries from storage`);
  }

  private async saveQueue(): Promise<void> {
    await this.state.storage.put('queue', this.queue);
    console.log(`MatchmakingQueue: Saved ${this.queue.length} entries to storage`);
  }

  private async loadPendingMatches(): Promise<void> {
    if (this.pendingMatchesLoaded) return;

    const stored = await this.state.storage.get<Array<[string, PendingMatch]>>('pendingMatches');
    if (stored) {
      const now = Date.now();
      this.pendingMatches = new Map(
        stored.filter(([_, match]) => match.expiresAt > now)
      );
    } else {
      this.pendingMatches = new Map();
    }

    this.pendingMatchesLoaded = true;
    console.log(`MatchmakingQueue: Loaded ${this.pendingMatches.size} pending matches from storage`);
  }

  private async savePendingMatches(): Promise<void> {
    await this.state.storage.put('pendingMatches', Array.from(this.pendingMatches.entries()));
    console.log(`MatchmakingQueue: Saved ${this.pendingMatches.size} pending matches to storage`);
  }

  private async cleanupExpiredPendingMatches(): Promise<void> {
    const now = Date.now();
    const initialCount = this.pendingMatches.size;

    for (const [playerId, match] of this.pendingMatches.entries()) {
      if (match.expiresAt <= now) {
        this.pendingMatches.delete(playerId);
      }
    }

    const removedCount = initialCount - this.pendingMatches.size;
    if (removedCount > 0) {
      console.log(`MatchmakingQueue: Cleaned up ${removedCount} expired pending matches`);
      await this.savePendingMatches();
    }
  }

  private calculateRatingRange(entry: QueueEntry): { min: number; max: number } {
    const waitTimeSeconds = (Date.now() - entry.joinedAt) / 1000;

    let range: number;

    if (waitTimeSeconds < 10) {
      range = 150;
    } else if (waitTimeSeconds < 20) {
      range = 150 + ((waitTimeSeconds - 10) * 10);
    } else if (waitTimeSeconds < 25) {
      range = 250 + ((waitTimeSeconds - 20) * 30);
    } else {
      range = 400 + ((waitTimeSeconds - 25) * 40);
    }

    const cappedRange = Math.min(range, 600);

    return {
      min: entry.rating - cappedRange,
      max: entry.rating + cappedRange,
    };
  }

  private findMatch(entry: QueueEntry): QueueEntry | null {
    const entryRange = this.calculateRatingRange(entry);
    entry.minRating = entryRange.min;
    entry.maxRating = entryRange.max;

    for (const opponent of this.queue) {
      if (opponent.gameMode !== entry.gameMode) continue;
      if (opponent.playerId === entry.playerId) continue;

      const opponentRange = this.calculateRatingRange(opponent);
      opponent.minRating = opponentRange.min;
      opponent.maxRating = opponentRange.max;

      const entryAcceptsOpponent =
        opponent.rating >= entry.minRating &&
        opponent.rating <= entry.maxRating;

      const opponentAcceptsEntry =
        entry.rating >= opponent.minRating &&
        entry.rating <= opponent.maxRating;

      if (entryAcceptsOpponent && opponentAcceptsEntry) {
        console.log(`MatchmakingQueue: Match found!`);
        return opponent;
      }
    }

    return null;
  }

  private async cleanupExpiredEntries(): Promise<void> {
    const now = Date.now();
    const initialCount = this.queue.length;

    this.queue = this.queue.filter(entry => entry.expiresAt > now);

    const removedCount = initialCount - this.queue.length;
    if (removedCount > 0) {
      console.log(`MatchmakingQueue: Cleaned up ${removedCount} expired entries`);
      await this.saveQueue();
    }
  }

  private generateGameRoomId(player1: string, player2: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 9);
    return `game-${timestamp}-${random}`;
  }

  private buildWebSocketUrl(origin: string, roomId: string, playerInfo: {
    playerId: string;
    displayName: string;
    rating: number;
    isProvisional: boolean;
    color: string;
  }): string {
    let cleanOrigin = origin;

    try {
      const url = new URL(origin);

      if (url.hostname === 'internal' || url.hostname === 'localhost' || url.port === '0') {
        cleanOrigin = 'https://checkmatex-worker-production.rohitvinod-dev.workers.dev';
      }

      if (url.port === '0' || url.port === '443' || url.port === '80') {
        cleanOrigin = `${url.protocol}//${url.hostname}`;
      }
    } catch (e) {
      console.error('Invalid origin provided:', origin, e);
      cleanOrigin = 'https://checkmatex-worker-production.rohitvinod-dev.workers.dev';
    }

    const wsBaseUrl = cleanOrigin
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:');

    const wsUrl = `${wsBaseUrl}/parties/game-room/${roomId}?` +
      `playerId=${encodeURIComponent(playerInfo.playerId)}` +
      `&displayName=${encodeURIComponent(playerInfo.displayName)}` +
      `&rating=${playerInfo.rating}` +
      `&isProvisional=${playerInfo.isProvisional}` +
      `&color=${playerInfo.color}`;

    if (wsUrl.includes(':0/') || wsUrl.includes(':0?')) {
      throw new Error(`Invalid WebSocket URL generated: ${wsUrl}`);
    }

    console.log(`Generated WebSocket URL: ${wsUrl}`);
    return wsUrl;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/queue/join" && request.method === "POST") {
      return this.handleJoinQueue(request);
    }

    if (url.pathname === "/queue/status" && request.method === "GET") {
      return this.handleStatusCheck(request);
    }

    if (url.pathname === "/queue/leave" && request.method === "POST") {
      return this.handleLeaveQueue(request);
    }

    if (url.pathname === "/queue/info" && request.method === "GET") {
      return this.handleQueueInfo();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleJoinQueue(request: Request): Promise<Response> {
    await this.loadQueue();
    await this.loadPendingMatches();
    await this.cleanupExpiredEntries();
    await this.cleanupExpiredPendingMatches();

    const body = await request.json() as {
      playerId: string;
      displayName: string;
      rating: number;
      isProvisional: boolean;
      gameMode: GameMode;
      joinedAt: number;
      origin?: string;
    };

    const pendingMatch = this.pendingMatches.get(body.playerId);
    if (pendingMatch) {
      console.log(`MatchmakingQueue: Player ${body.playerId} has pending match, returning it`);
      this.pendingMatches.delete(body.playerId);
      await this.savePendingMatches();

      return new Response(
        JSON.stringify({
          matched: true,
          roomId: pendingMatch.roomId,
          color: pendingMatch.color,
          opponentId: pendingMatch.opponentId,
          opponentDisplayName: pendingMatch.opponentDisplayName,
          opponentRating: pendingMatch.opponentRating,
          accessToken: pendingMatch.accessToken,
          webSocketUrl: pendingMatch.webSocketUrl,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const existingIndex = this.queue.findIndex(e => e.playerId === body.playerId);
    if (existingIndex !== -1) {
      this.queue.splice(existingIndex, 1);
      console.log(`MatchmakingQueue: Removed duplicate entry for player ${body.playerId}`);
    }

    const now = Date.now();
    const entry: QueueEntry = {
      playerId: body.playerId,
      displayName: body.displayName,
      rating: body.rating,
      isProvisional: body.isProvisional,
      gameMode: body.gameMode,
      joinedAt: body.joinedAt || now,
      minRating: 0,
      maxRating: 0,
      expiresAt: now + (MATCHMAKING_TIMEOUT_SECONDS * 1000),
      origin: body.origin,
    };

    const range = this.calculateRatingRange(entry);
    entry.minRating = range.min;
    entry.maxRating = range.max;

    const match = this.findMatch(entry);

    if (match) {
      this.queue = this.queue.filter(e => e.playerId !== match.playerId);
      await this.saveQueue();

      const roomId = this.generateGameRoomId(entry.playerId, match.playerId);

      try {
        const statsNamespace = this.env.STATS_TRACKER;
        const statsId = statsNamespace.idFromName("global-stats");
        const statsStub = statsNamespace.get(statsId);
        await statsStub.fetch(
          new Request("https://internal/stats/game-created", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: roomId }),
          })
        );
      } catch (error) {
        console.error("Failed to track game creation:", error);
      }

      const playerColor = Math.random() > 0.5 ? "white" : "black";
      const opponentColor = playerColor === "white" ? "black" : "white";

      const playerAccessToken = this.generateAccessToken(entry.playerId);
      const opponentAccessToken = this.generateAccessToken(match.playerId);

      const playerWsUrl = this.buildWebSocketUrl(
        body.origin || "https://checkmatex-worker-production.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: entry.playerId,
          displayName: entry.displayName,
          rating: entry.rating,
          isProvisional: entry.isProvisional,
          color: playerColor,
        }
      );

      const opponentWsUrl = this.buildWebSocketUrl(
        body.origin || "https://checkmatex-worker-production.rohitvinod-dev.workers.dev",
        roomId,
        {
          playerId: match.playerId,
          displayName: match.displayName,
          rating: match.rating,
          isProvisional: match.isProvisional,
          color: opponentColor,
        }
      );

      const matchExpiresAt = now + (60 * 1000);

      const opponentPendingMatch: PendingMatch = {
        roomId,
        color: opponentColor,
        opponentId: entry.playerId,
        opponentDisplayName: entry.displayName,
        opponentRating: entry.rating,
        accessToken: opponentAccessToken,
        webSocketUrl: opponentWsUrl,
        createdAt: now,
        expiresAt: matchExpiresAt,
      };

      this.pendingMatches.set(match.playerId, opponentPendingMatch);
      await this.savePendingMatches();

      console.log(`MatchmakingQueue: Created match ${roomId}`);

      return new Response(
        JSON.stringify({
          matched: true,
          roomId,
          color: playerColor,
          opponentId: match.playerId,
          opponentDisplayName: match.displayName,
          opponentRating: match.rating,
          accessToken: playerAccessToken,
          webSocketUrl: playerWsUrl,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    this.queue.push(entry);
    await this.saveQueue();

    return new Response(
      JSON.stringify({
        matched: false,
        queuePosition: this.queue.length,
        estimatedWait: MATCHMAKING_TIMEOUT_SECONDS,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  private async handleStatusCheck(request: Request): Promise<Response> {
    // Implementation similar to handleJoinQueue but for status checking
    const url = new URL(request.url);
    const playerId = url.searchParams.get('playerId');

    if (!playerId) {
      return new Response(JSON.stringify({ error: 'Missing playerId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await this.loadQueue();
    await this.loadPendingMatches();
    await this.cleanupExpiredEntries();
    await this.cleanupExpiredPendingMatches();

    const entry = this.queue.find(e => e.playerId === playerId);

    if (!entry) {
      return new Response(JSON.stringify({
        inQueue: false,
        message: 'Player not in queue',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const waitTime = (Date.now() - entry.joinedAt) / 1000;
    const range = this.calculateRatingRange(entry);

    return new Response(JSON.stringify({
      inQueue: true,
      matched: false,
      queuePosition: this.queue.indexOf(entry) + 1,
      totalInQueue: this.queue.length,
      waitTimeSeconds: Math.floor(waitTime),
      currentRatingRange: range,
      expiresIn: Math.floor((entry.expiresAt - Date.now()) / 1000),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleLeaveQueue(request: Request): Promise<Response> {
    const body = await request.json() as { playerId: string };

    await this.loadQueue();

    const initialLength = this.queue.length;
    this.queue = this.queue.filter(e => e.playerId !== body.playerId);

    if (this.queue.length < initialLength) {
      await this.saveQueue();
      console.log(`MatchmakingQueue: Player ${body.playerId} left queue`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleQueueInfo(): Promise<Response> {
    await this.loadQueue();
    await this.cleanupExpiredEntries();

    return new Response(
      JSON.stringify({
        queueSize: this.queue.length,
        players: this.queue.map((entry) => ({
          gameMode: entry.gameMode,
          rating: entry.rating,
          waitTime: Date.now() - entry.joinedAt,
          expiresIn: Math.floor((entry.expiresAt - Date.now()) / 1000),
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  private generateAccessToken(playerId: string): string {
    const payload = {
      playerId,
      iat: Date.now(),
      exp: Date.now() + 3600000,
    };
    const jsonStr = JSON.stringify(payload);
    return btoa(jsonStr);
  }
}

// ============ STATS TRACKER (from old index.ts) ============
export class StatsTracker {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = this.state.storage.sql;
    this.initializeDatabase();
  }

  private initializeDatabase() {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS active_connections (
        connection_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        connected_at INTEGER NOT NULL
      )`
    );

    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS game_history (
        game_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`
    );

    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_game_created_at ON game_history(created_at)`
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/stats/online-players" && request.method === "GET") {
      try {
        const result = this.sql.exec(
          `SELECT COUNT(DISTINCT player_id) as count FROM active_connections`
        );
        const count = result.toArray()[0]?.count || 0;

        return new Response(
          JSON.stringify({ count }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error getting online players:", error);
        return new Response(
          JSON.stringify({ count: 0, error: String(error) }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/stats/games-24h" && request.method === "GET") {
      try {
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);

        this.sql.exec(
          `DELETE FROM game_history WHERE created_at < ${twoDaysAgo}`
        );

        const result = this.sql.exec(
          `SELECT COUNT(*) as count FROM game_history WHERE created_at >= ${oneDayAgo}`
        );
        const count = result.toArray()[0]?.count || 0;

        return new Response(
          JSON.stringify({ count }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error getting games-24h:", error);
        return new Response(
          JSON.stringify({ count: 0, error: String(error) }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/stats/player-connected" && request.method === "POST") {
      try {
        const body = await request.json() as { playerId: string; connectionId: string };

        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        this.sql.exec(
          `DELETE FROM active_connections WHERE connected_at < ${fiveMinutesAgo}`
        );

        this.sql.exec(
          `INSERT OR REPLACE INTO active_connections (connection_id, player_id, connected_at)
           VALUES ('${body.connectionId}', '${body.playerId}', ${Date.now()})`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking player connection:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/stats/player-disconnected" && request.method === "POST") {
      try {
        const body = await request.json() as { connectionId: string };

        this.sql.exec(
          `DELETE FROM active_connections WHERE connection_id = '${body.connectionId}'`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking player disconnection:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/stats/game-created" && request.method === "POST") {
      try {
        const body = await request.json() as { gameId: string };

        this.sql.exec(
          `INSERT OR IGNORE INTO game_history (game_id, created_at)
           VALUES ('${body.gameId}', ${Date.now()})`
        );

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      } catch (error) {
        console.error("Error tracking game creation:", error);
        return new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
}

// ============ MAIN WORKER ============
function getCanonicalOrigin(requestUrl: string): string {
  try {
    const url = new URL(requestUrl);

    if (url.hostname === 'internal' || url.hostname === 'localhost' || url.port === '0') {
      return 'https://checkmatex-worker-production.rohitvinod-dev.workers.dev';
    }

    const protocol = url.protocol;
    const hostname = url.hostname;
    const port = url.port;

    if (port === '' || port === '0' ||
        (protocol === 'https:' && port === '443') ||
        (protocol === 'http:' && port === '80')) {
      return `${protocol}//${hostname}`;
    }

    return `${protocol}//${hostname}:${port}`;
  } catch (e) {
    console.error('Failed to parse request URL:', e);
    return 'https://checkmatex-worker-production.rohitvinod-dev.workers.dev';
  }
}

async function handleMatchmake(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as {
      playerId: string;
      displayName: string;
      rating: number;
      isProvisional: boolean;
      gameMode: GameMode;
      authToken: string;
    };

    const {
      playerId,
      displayName,
      rating,
      isProvisional,
      gameMode,
      authToken,
    } = body;

    if (!playerId || !gameMode || !authToken) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const queueNamespace = env.MATCHMAKING_QUEUE;
    const queueId = queueNamespace.idFromName("global-queue");
    const queueStub = queueNamespace.get(queueId);

    const realOrigin = getCanonicalOrigin(request.url);
    console.log('Extracted origin:', realOrigin, 'from request URL:', request.url);
    const response = await queueStub.fetch(
      new Request("https://internal/queue/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerId,
          displayName,
          rating,
          isProvisional,
          gameMode,
          joinedAt: Date.now(),
          origin: realOrigin,
        }),
      })
    );

    if (!response.ok) {
      return response;
    }

    const matchInfo = await response.json() as {
      matched: boolean;
      roomId?: string;
      color?: string;
      accessToken?: string;
      webSocketUrl?: string;
      queuePosition?: number;
      estimatedWait?: number;
    };

    return new Response(JSON.stringify(matchInfo), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in matchmake:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: String(error),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function handleOnlinePlayersStats(env: Env): Promise<Response> {
  try {
    const statsNamespace = env.STATS_TRACKER;
    const statsId = statsNamespace.idFromName("global-stats");
    const statsStub = statsNamespace.get(statsId);

    const response = await statsStub.fetch(
      new Request("https://internal/stats/online-players", {
        method: "GET",
      })
    );

    return response;
  } catch (error) {
    console.error("Error fetching online players stats:", error);
    return new Response(
      JSON.stringify({ count: 0, error: String(error) }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}

async function handleGames24hStats(env: Env): Promise<Response> {
  try {
    const statsNamespace = env.STATS_TRACKER;
    const statsId = statsNamespace.idFromName("global-stats");
    const statsStub = statsNamespace.get(statsId);

    const response = await statsStub.fetch(
      new Request("https://internal/stats/games-24h", {
        method: "GET",
      })
    );

    return response;
  } catch (error) {
    console.error("Error fetching games-24h stats:", error);
    return new Response(
      JSON.stringify({ count: 0, error: String(error) }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route PartyKit requests (chat and games)
    const partykitResponse = await routePartykitRequest(request, {
      ...env,
    });
    if (partykitResponse) {
      return partykitResponse;
    }

    // Initialize Firestore client
    const firestore = new FirestoreClient({
      projectId: env.FIREBASE_PROJECT_ID,
      serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
    });

    try {
      // ========== MULTIPLAYER ENDPOINTS ==========

      // Matchmaking
      if (url.pathname === "/matchmake" && request.method === "POST") {
        return handleMatchmake(request, env);
      }

      // Match result processing
      if (url.pathname === '/api/multiplayer/match-result' && request.method === 'POST') {
        const response = await handleMatchResult(request, firestore);
        return addCorsHeaders(response, corsHeaders);
      }

      // Player ratings
      if (url.pathname === '/api/multiplayer/ratings' && request.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
          return new Response(
            JSON.stringify({ error: 'Missing playerId parameter' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const ratings = await firestore.getDocument(`users/${playerId}/profile/ratings`);
        return new Response(
          JSON.stringify(ratings || { elo: 1200, eloGamesPlayed: 0 }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ========== USER ENDPOINTS ==========

      // Username uniqueness check
      if (url.pathname === '/api/users/username/check' && request.method === 'GET') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const username = url.searchParams.get('username');
        if (!username) {
          return new Response(
            JSON.stringify({ error: 'Missing username parameter' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Check the atomic usernames collection for uniqueness
        // This is the single source of truth for username ownership
        const usernameLower = username.toLowerCase();
        const existingClaim = await firestore.getDocument(`usernames/${usernameLower}`);

        // Username is unique if:
        // 1. No claim exists in the registry, OR
        // 2. The claim belongs to the current user (they can keep their own username)
        const isUnique = !existingClaim || existingClaim.uid === user.uid;

        return new Response(
          JSON.stringify({ isUnique }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Ensure user profile (Phase 2)
      if (url.pathname === '/api/users/profile' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleEnsureUserProfile(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // Register device token (Phase 2)
      if (url.pathname === '/api/users/device' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleRegisterDevice(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // Delete user account (deletes all Firestore data)
      if (url.pathname === '/api/users/delete-account' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleDeleteAccount(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // ========== PROGRESS TRACKING ENDPOINTS (Phase 2) ==========

      // Record progress event
      if (url.pathname === '/api/progress/record' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleRecordProgress(request, firestore, user, env);
        return addCorsHeaders(response, corsHeaders);
      }

      // Claim energy reward
      if (url.pathname === '/api/progress/energy/claim' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleClaimEnergyReward(request, firestore, user, env);
        return addCorsHeaders(response, corsHeaders);
      }

      // Submit Puzzle Trouble result
      if (url.pathname === '/api/progress/puzzle-trouble' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handlePuzzleTroubleSubmit(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // ========== NOTIFICATION ENDPOINTS (Phase 3) ==========

      // Enqueue notification
      if (url.pathname === '/api/notifications/enqueue' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleEnqueueNotification(request, firestore, user, env);
        return addCorsHeaders(response, corsHeaders);
      }

      // Update notification preferences
      if (url.pathname === '/api/notifications/preferences' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleUpdateNotificationPreferences(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // Track notification opened
      if (url.pathname === '/api/notifications/track' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleTrackNotificationOpened(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // ========== CUSTOM OPENINGS & ACHIEVEMENTS ENDPOINTS (Phase 4) ==========

      // Manage custom openings (CRUD)
      if (url.pathname === '/api/openings/manage' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleManageOpenings(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // Sync achievements
      if (url.pathname === '/api/achievements/sync' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await handleSyncAchievements(request, firestore, user);
        return addCorsHeaders(response, corsHeaders);
      }

      // ========== LOBBY ENDPOINTS ==========

      // Create lobby
      if (url.pathname === '/api/lobby/create' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await createLobbyHandler(request, env, user.uid);
        return addCorsHeaders(response, corsHeaders);
      }

      // List lobbies
      if (url.pathname === '/api/lobby/list' && request.method === 'GET') {
        const response = await listLobbiesHandler(request, env);
        return addCorsHeaders(response, corsHeaders);
      }

      // Join lobby
      if (url.pathname === '/api/lobby/join' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await joinLobbyHandler(request, env, user.uid);
        return addCorsHeaders(response, corsHeaders);
      }

      // Spectate lobby
      if (url.pathname === '/api/lobby/spectate' && request.method === 'POST') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const response = await spectateLobbyHandler(request, env, user.uid);
        return addCorsHeaders(response, corsHeaders);
      }

      // Delete lobby
      if (url.pathname.startsWith('/api/lobby/') && url.pathname !== '/api/lobby/clear-all' && request.method === 'DELETE') {
        const user = await authenticateRequest(request, env.FIREBASE_PROJECT_ID);
        const lobbyId = url.pathname.split('/')[3];
        const response = await deleteLobbyHandler(request, env, user.uid, lobbyId);
        return addCorsHeaders(response, corsHeaders);
      }

      // Clear all lobbies (admin/debug endpoint)
      if (url.pathname === '/api/lobby/clear-all' && request.method === 'DELETE') {
        // Get LobbyList Durable Object
        const lobbyListId = env.LOBBY_LIST.idFromName('global');
        const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

        // Call clear-all endpoint
        const response = await lobbyListStub.fetch(new Request('https://lobby-list/clear-all', {
          method: 'DELETE',
        }));

        const result = await response.json();
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Cleanup stale lobbies
      if (url.pathname === '/api/lobby/cleanup-stale' && request.method === 'POST') {
        // Get LobbyList Durable Object
        const lobbyListId = env.LOBBY_LIST.idFromName('global');
        const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);

        // Call cleanup-stale endpoint
        const response = await lobbyListStub.fetch(new Request('https://lobby-list/cleanup-stale', {
          method: 'POST',
        }));

        const result = await response.json();
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // ========== ADMIN ENDPOINTS ==========

      if (url.pathname === '/api/admin/migrate-usernames' && request.method === 'GET') {
        // Verify admin secret
        const adminSecret = request.headers.get('X-Admin-Secret');
        if (adminSecret !== 'checkmatex-admin-2024') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return handleMigrateUsernames(request, env);
      }

      if (url.pathname === '/api/admin/sync-ratings-to-leaderboard' && request.method === 'GET') {
        // Verify admin secret
        const adminSecret = request.headers.get('X-Admin-Secret');
        if (adminSecret !== 'checkmatex-admin-2024') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return handleSyncRatingsToLeaderboard(request, env);
      }

      if (url.pathname === '/api/admin/migrate-elo-modes' && request.method === 'GET') {
        // Verify admin secret
        const adminSecret = request.headers.get('X-Admin-Secret');
        if (adminSecret !== 'checkmatex-admin-2024') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return handleMigrateEloModes(request, env);
      }

      if (url.pathname === '/api/admin/update-opening' && request.method === 'POST') {
        // Verify admin secret
        const adminSecret = request.headers.get('X-Admin-Secret');
        if (adminSecret !== 'checkmatex-admin-2024') {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return handleUpdateOpening(request, env);
      }

      // ========== STATS ENDPOINTS ==========

      if (url.pathname === "/stats/online-players" && request.method === "GET") {
        return handleOnlinePlayersStats(env);
      }

      if (url.pathname === "/stats/games-24h" && request.method === "GET") {
        return handleGames24hStats(env);
      }

      // ========== HEALTH CHECK ==========

      if (url.pathname === '/health' && request.method === 'GET') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            timestamp: Date.now(),
            environment: env.ENVIRONMENT,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Fall back to static assets or 404
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error', message: String(error) }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },

  // ========== SCHEDULED CRON JOBS (Phase 5 - Direct Processing for Free Plan) ==========
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered at ${new Date(event.scheduledTime).toISOString()}`);
    console.log(`[Cron] Cron expression: ${event.cron}`);

    // Initialize Firestore client
    const firestore = new FirestoreClient(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_PROJECT_ID);

    // Check if queues are available (paid plan feature)
    const queuesAvailable = env.CLEANUP_QUEUE && env.REMINDERS_QUEUE && env.LAST_CHANCE_QUEUE;

    try {
      switch (event.cron) {
        case '0 2 * * *': {
          // 2 AM UTC - Daily leaderboard cleanup + lobby cleanup
          if (queuesAvailable) {
            console.log('[Cron] Using queue-based cleanup (paid plan)...');
            const result = await enqueueLeaderboardCleanup(firestore, env.CLEANUP_QUEUE);
            console.log(`[Cron] Cleanup enqueue result:`, result);
          } else {
            console.log('[Cron] Using direct cleanup (free plan)...');
            const result = await cleanupLeaderboardsDirectly(firestore);
            console.log(`[Cron] Direct cleanup result:`, result);
          }

          // Also cleanup stale lobbies
          try {
            console.log('[Cron] Cleaning up stale lobbies...');
            const lobbyListId = env.LOBBY_LIST.idFromName('global');
            const lobbyListStub = env.LOBBY_LIST.get(lobbyListId);
            const cleanupResult = await lobbyListStub.fetch(new Request('https://lobby-list/cleanup-stale', {
              method: 'POST',
            }));
            const cleanupData = await cleanupResult.json() as { removed: number };
            console.log(`[Cron] Lobby cleanup: ${cleanupData.removed} stale lobbies removed`);
          } catch (e) {
            console.error('[Cron] Lobby cleanup failed:', e);
          }
          break;
        }

        case '0 9 * * *': {
          // 9 AM UTC - Daily streak reminders
          if (queuesAvailable) {
            console.log('[Cron] Using queue-based reminders (paid plan)...');
            const result = await enqueueStreakReminders(firestore, env.REMINDERS_QUEUE);
            console.log(`[Cron] Reminders enqueue result:`, result);
          } else {
            console.log('[Cron] Using direct reminders (free plan)...');
            const result = await sendStreakRemindersDirectly(firestore, env);
            console.log(`[Cron] Direct reminders result:`, result);
          }
          break;
        }

        case '0 21 * * *': {
          // 9 PM UTC - Last-chance streak savers
          if (queuesAvailable) {
            console.log('[Cron] Using queue-based last-chance (paid plan)...');
            const result = await enqueueLastChanceReminders(firestore, env.LAST_CHANCE_QUEUE);
            console.log(`[Cron] Last-chance enqueue result:`, result);
          } else {
            console.log('[Cron] Using direct last-chance (free plan)...');
            const result = await sendLastChanceRemindersDirectly(firestore, env);
            console.log(`[Cron] Direct last-chance result:`, result);
          }
          break;
        }

        case '0 10 * * *': {
          // 10 AM UTC - Win-back notifications for inactive users
          console.log('[Cron] Sending win-back notifications...');
          const result = await sendWinBackNotifications(firestore, env);
          console.log(`[Cron] Win-back result:`, result);
          break;
        }

        case '0 18 * * SUN': {
          // 6 PM UTC on Sundays - Weekly progress summaries
          console.log('[Cron] Sending weekly progress summaries...');
          const result = await sendWeeklyProgressSummaries(firestore, env);
          console.log(`[Cron] Weekly summary result:`, result);
          break;
        }

        default:
          console.warn(`[Cron] Unknown cron expression: ${event.cron}`);
      }
    } catch (error) {
      console.error('[Cron] Scheduled job failed:', error);
      // Don't throw - let the cron continue on next schedule
    }
  },

  // ========== QUEUE CONSUMERS (Phase 5 - Process Messages in Parallel) ==========
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Queue] Processing batch from queue: ${batch.queue}`);
    console.log(`[Queue] Batch size: ${batch.messages.length} messages`);

    // Initialize Firestore client
    const firestore = new FirestoreClient(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_PROJECT_ID);

    try {
      // Route to appropriate queue consumer based on queue name
      switch (batch.queue) {
        case 'leaderboard-cleanup-queue': {
          const result = await processCleanupBatch(batch as any, firestore);
          console.log(`[Queue] Cleanup batch result:`, result);
          break;
        }

        case 'streak-reminders-queue': {
          const result = await processRemindersBatch(batch as any, firestore, env);
          console.log(`[Queue] Reminders batch result:`, result);
          break;
        }

        case 'last-chance-queue': {
          const result = await processLastChanceBatch(batch as any, firestore, env);
          console.log(`[Queue] Last-chance batch result:`, result);
          break;
        }

        default:
          console.warn(`[Queue] Unknown queue: ${batch.queue}`);
          // Ack all messages to prevent redelivery
          batch.messages.forEach(msg => msg.ack());
      }
    } catch (error) {
      console.error('[Queue] Queue processing failed:', error);
      // Messages will be retried automatically (up to max_retries)
    }
  },
} satisfies ExportedHandler<Env>;

// Helper to add CORS headers to response
function addCorsHeaders(response: Response, corsHeaders: Record<string, string>): Response {
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

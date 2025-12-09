/**
 * Monitoring and Alerting Utilities
 *
 * Provides structured logging, metrics tracking, and alerting capabilities
 * for Cloudflare Workers
 */

export interface MetricData {
  metric: string;
  value: number;
  tags?: Record<string, string | number>;
  timestamp?: number;
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  message: string;
  data?: any;
  endpoint?: string;
  userId?: string;
  duration?: number;
  timestamp?: number;
}

export interface AlertConfig {
  webhookUrl?: string;
  enabled: boolean;
  minSeverity: 'error' | 'critical';
}

/**
 * Log structured data to console
 */
export function log(entry: LogEntry): void {
  const logData = {
    ...entry,
    timestamp: entry.timestamp || Date.now(),
    environment: globalThis.ENVIRONMENT || 'unknown',
  };

  const logString = JSON.stringify(logData);

  switch (entry.level) {
    case 'debug':
      console.debug(logString);
      break;
    case 'info':
      console.info(logString);
      break;
    case 'warn':
      console.warn(logString);
      break;
    case 'error':
    case 'critical':
      console.error(logString);
      break;
  }
}

/**
 * Log metric data for monitoring
 */
export function logMetric(data: MetricData): void {
  const metricData = {
    ...data,
    timestamp: data.timestamp || Date.now(),
    type: 'metric',
  };

  console.log(JSON.stringify(metricData));
}

/**
 * Track API request metrics
 */
export async function trackRequest(
  endpoint: string,
  method: string,
  handler: () => Promise<Response>
): Promise<Response> {
  const startTime = Date.now();
  let statusCode = 500;
  let error: Error | null = null;

  try {
    const response = await handler();
    statusCode = response.status;
    return response;
  } catch (e) {
    error = e as Error;
    throw e;
  } finally {
    const duration = Date.now() - startTime;

    // Log request metrics
    logMetric({
      metric: 'http_request_duration_ms',
      value: duration,
      tags: {
        endpoint,
        method,
        status: statusCode,
      },
    });

    // Log request info
    log({
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
      message: `${method} ${endpoint} - ${statusCode}`,
      endpoint,
      duration,
      data: error ? { error: error.message } : undefined,
    });

    // Alert on errors
    if (statusCode >= 500 || error) {
      await sendAlert({
        severity: statusCode >= 500 ? 'critical' : 'error',
        title: `HTTP ${statusCode} Error`,
        message: `${method} ${endpoint} failed with ${statusCode}`,
        details: {
          endpoint,
          method,
          statusCode,
          duration,
          error: error?.message,
          stack: error?.stack,
        },
      });
    }
  }
}

/**
 * Send alert via webhook (Discord, Slack, etc.)
 */
export async function sendAlert(alert: {
  severity: 'info' | 'warn' | 'error' | 'critical';
  title: string;
  message: string;
  details?: any;
}): Promise<void> {
  // Get webhook URL from environment
  const webhookUrl = globalThis.ALERT_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('Alert webhook not configured, skipping alert');
    return;
  }

  // Skip non-critical alerts based on config
  const minSeverity = globalThis.ALERT_MIN_SEVERITY || 'error';
  const severityLevels = { info: 0, warn: 1, error: 2, critical: 3 };

  if (severityLevels[alert.severity] < severityLevels[minSeverity]) {
    return; // Skip alert
  }

  const emoji = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '🚨',
    critical: '🔥',
  }[alert.severity];

  const payload = {
    content: `${emoji} **${alert.title}**\n${alert.message}`,
    embeds: alert.details ? [{
      title: 'Details',
      description: '```json\n' + JSON.stringify(alert.details, null, 2) + '\n```',
      color: {
        info: 3447003,     // Blue
        warn: 16776960,    // Yellow
        error: 16711680,   // Red
        critical: 10038562, // Dark red
      }[alert.severity],
      timestamp: new Date().toISOString(),
    }] : undefined,
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Failed to send alert:', error);
  }
}

/**
 * Monitor Durable Object performance
 */
export function monitorDurableObject(
  objectType: string,
  operation: string,
  handler: () => Promise<any>
): Promise<any> {
  const startTime = Date.now();

  return handler()
    .then((result) => {
      const duration = Date.now() - startTime;

      logMetric({
        metric: 'durable_object_operation_duration_ms',
        value: duration,
        tags: {
          object_type: objectType,
          operation,
        },
      });

      // Alert on slow operations (> 5 seconds)
      if (duration > 5000) {
        sendAlert({
          severity: 'warn',
          title: 'Slow Durable Object Operation',
          message: `${objectType}.${operation} took ${duration}ms`,
          details: { objectType, operation, duration },
        });
      }

      return result;
    })
    .catch((error) => {
      const duration = Date.now() - startTime;

      log({
        level: 'error',
        message: `Durable Object operation failed: ${objectType}.${operation}`,
        data: {
          objectType,
          operation,
          duration,
          error: error.message,
          stack: error.stack,
        },
      });

      sendAlert({
        severity: 'error',
        title: 'Durable Object Operation Failed',
        message: `${objectType}.${operation} failed`,
        details: {
          objectType,
          operation,
          duration,
          error: error.message,
          stack: error.stack,
        },
      });

      throw error;
    });
}

/**
 * Track Firestore operation performance
 */
export async function monitorFirestoreOperation<T>(
  operation: string,
  collection: string,
  handler: () => Promise<T>
): Promise<T> {
  const startTime = Date.now();

  try {
    const result = await handler();
    const duration = Date.now() - startTime;

    logMetric({
      metric: 'firestore_operation_duration_ms',
      value: duration,
      tags: {
        operation,
        collection,
      },
    });

    // Warn on slow Firestore operations (> 1 second)
    if (duration > 1000) {
      log({
        level: 'warn',
        message: `Slow Firestore operation: ${operation} on ${collection}`,
        data: { operation, collection, duration },
      });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    log({
      level: 'error',
      message: `Firestore operation failed: ${operation} on ${collection}`,
      data: {
        operation,
        collection,
        duration,
        error: (error as Error).message,
      },
    });

    throw error;
  }
}

/**
 * Create performance timer
 */
export function createTimer(name: string) {
  const startTime = Date.now();

  return {
    stop: (tags?: Record<string, string | number>) => {
      const duration = Date.now() - startTime;

      logMetric({
        metric: 'operation_duration_ms',
        value: duration,
        tags: {
          operation: name,
          ...tags,
        },
      });

      return duration;
    },
  };
}

/**
 * Health check utility
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, boolean>;
  timestamp: number;
  environment: string;
}

export async function performHealthCheck(env: any): Promise<HealthStatus> {
  const checks: Record<string, boolean> = {};

  // Check 1: Environment variables
  checks.firebase_config = !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_SERVICE_ACCOUNT);

  // Check 2: Durable Object bindings
  checks.durable_objects = !!(
    env.GAME_ROOM &&
    env.CHAT &&
    env.MATCHMAKING_QUEUE &&
    env.USER_PROFILE
  );

  // Determine overall status
  const allChecks = Object.values(checks);
  const passedChecks = allChecks.filter(Boolean).length;

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (passedChecks === allChecks.length) {
    status = 'healthy';
  } else if (passedChecks >= allChecks.length / 2) {
    status = 'degraded';
  } else {
    status = 'unhealthy';
  }

  const healthStatus: HealthStatus = {
    status,
    checks,
    timestamp: Date.now(),
    environment: env.ENVIRONMENT || 'unknown',
  };

  // Alert on unhealthy status
  if (status === 'unhealthy') {
    await sendAlert({
      severity: 'critical',
      title: 'Worker Health Check Failed',
      message: 'Worker is unhealthy',
      details: healthStatus,
    });
  } else if (status === 'degraded') {
    await sendAlert({
      severity: 'warn',
      title: 'Worker Health Degraded',
      message: 'Some health checks are failing',
      details: healthStatus,
    });
  }

  return healthStatus;
}

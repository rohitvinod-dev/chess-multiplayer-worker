/**
 * Load Testing Script for CheckmateX Worker
 *
 * Uses k6 for load testing
 * Install k6: https://k6.io/docs/getting-started/installation/
 * Run: k6 run tests/load/load-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const healthCheckDuration = new Trend('health_check_duration');
const matchResultDuration = new Trend('match_result_duration');
const progressRecordDuration = new Trend('progress_record_duration');

// Test configuration
export const options = {
  stages: [
    // Warm-up phase
    { duration: '1m', target: 50 },    // Ramp up to 50 users

    // Normal load
    { duration: '3m', target: 100 },   // Ramp to 100 users
    { duration: '5m', target: 100 },   // Stay at 100 users

    // Spike test
    { duration: '2m', target: 500 },   // Spike to 500 users
    { duration: '3m', target: 500 },   // Sustain spike

    // Stress test
    { duration: '2m', target: 1000 },  // Ramp to 1000 users
    { duration: '5m', target: 1000 },  // Sustain stress

    // Cool down
    { duration: '2m', target: 0 },     // Ramp down
  ],

  thresholds: {
    'http_req_duration': ['p(95)<200'],     // 95% of requests under 200ms
    'http_req_failed': ['rate<0.01'],       // Error rate under 1%
    'errors': ['rate<0.005'],               // Custom error rate under 0.5%
  },
};

// Configuration
const BASE_URL = __ENV.BASE_URL || 'https://checkmatex-worker-production.YOUR_SUBDOMAIN.workers.dev';
const TEST_USER_ID = 'load-test-user-' + Math.random().toString(36).substring(7);

// Helper function to generate random match data
function generateMatchData() {
  return {
    matchId: `match_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    whitePlayerId: `player_${Math.floor(Math.random() * 10000)}`,
    blackPlayerId: `player_${Math.floor(Math.random() * 10000)}`,
    winner: ['white', 'black', 'draw'][Math.floor(Math.random() * 3)],
    moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],
    fen: 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    duration: Math.floor(Math.random() * 1200) + 60,
  };
}

// Helper function to generate progress data
function generateProgressData() {
  return {
    eventId: `event_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    openingId: `opening_${Math.floor(Math.random() * 100)}`,
    variationId: `variation_${Math.floor(Math.random() * 10)}`,
    correct: Math.random() > 0.3,
    completed: Math.random() > 0.7,
  };
}

export default function () {
  // Group 1: Health Check
  group('Health Check', function () {
    const startTime = new Date();
    const res = http.get(`${BASE_URL}/health`);
    healthCheckDuration.add(new Date() - startTime);

    const success = check(res, {
      'health status is 200': (r) => r.status === 200,
      'health response is valid JSON': (r) => {
        try {
          JSON.parse(r.body);
          return true;
        } catch {
          return false;
        }
      },
      'health has status field': (r) => {
        const body = JSON.parse(r.body);
        return body.status === 'ok';
      },
    });

    errorRate.add(!success);
  });

  sleep(0.5);

  // Group 2: Username Check
  group('Username Availability', function () {
    const username = `testuser_${Math.random().toString(36).substring(7)}`;
    const res = http.get(`${BASE_URL}/api/users/username/check?username=${username}`);

    const success = check(res, {
      'username check status is 200': (r) => r.status === 200,
      'username response is valid': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.hasOwnProperty('available');
        } catch {
          return false;
        }
      },
    });

    errorRate.add(!success);
  });

  sleep(0.5);

  // Group 3: Match Result Processing
  group('Match Result Processing', function () {
    const matchData = generateMatchData();
    const startTime = new Date();

    const res = http.post(
      `${BASE_URL}/api/multiplayer/match-result`,
      JSON.stringify(matchData),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    matchResultDuration.add(new Date() - startTime);

    const success = check(res, {
      'match result status is 200': (r) => r.status === 200,
      'match result has ELO updates': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.success && body.white && body.black;
        } catch {
          return false;
        }
      },
    });

    errorRate.add(!success);
  });

  sleep(0.5);

  // Group 4: Player Ratings
  group('Player Ratings Query', function () {
    const playerId = `player_${Math.floor(Math.random() * 10000)}`;
    const res = http.get(`${BASE_URL}/api/multiplayer/ratings?playerId=${playerId}`);

    const success = check(res, {
      'ratings status is 200': (r) => r.status === 200,
      'ratings response is valid': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.hasOwnProperty('elo');
        } catch {
          return false;
        }
      },
    });

    errorRate.add(!success);
  });

  sleep(1);
}

// Teardown function
export function teardown(data) {
  console.log('Load test completed!');
  console.log(`Test duration: ${options.stages.reduce((sum, stage) => {
    const duration = stage.duration.replace(/[^\d]/g, '');
    const unit = stage.duration.replace(/[\d]/g, '');
    return sum + parseInt(duration);
  }, 0)} minutes`);
}

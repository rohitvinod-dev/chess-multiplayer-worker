/**
 * Performance Benchmarking Utilities
 * Compare Cloudflare Worker vs Firebase Functions performance
 */

interface BenchmarkResult {
  endpoint: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  requestsPerSecond: number;
  errorRate: number;
  totalDuration: number;
}

interface BenchmarkConfig {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  concurrency: number;
  totalRequests: number;
  warmupRequests?: number;
}

/**
 * Run performance benchmark on an endpoint
 */
export async function runBenchmark(
  config: BenchmarkConfig
): Promise<BenchmarkResult> {
  const responseTimes: number[] = [];
  let successCount = 0;
  let failCount = 0;

  console.log(`\n🏁 Starting benchmark for ${config.endpoint}`);
  console.log(`   Concurrency: ${config.concurrency}`);
  console.log(`   Total requests: ${config.totalRequests}`);

  // Warmup phase
  if (config.warmupRequests && config.warmupRequests > 0) {
    console.log(`   Warming up with ${config.warmupRequests} requests...`);
    for (let i = 0; i < config.warmupRequests; i++) {
      await makeRequest(config);
    }
  }

  const startTime = Date.now();

  // Main benchmark
  const batches = Math.ceil(config.totalRequests / config.concurrency);

  for (let batch = 0; batch < batches; batch++) {
    const batchSize = Math.min(
      config.concurrency,
      config.totalRequests - batch * config.concurrency
    );

    const promises = Array.from({ length: batchSize }, async () => {
      const requestStart = Date.now();
      try {
        const response = await makeRequest(config);
        const responseTime = Date.now() - requestStart;

        if (response.ok) {
          successCount++;
          responseTimes.push(responseTime);
        } else {
          failCount++;
        }
      } catch (error) {
        failCount++;
      }
    });

    await Promise.all(promises);

    // Progress indicator
    const completed = (batch + 1) * config.concurrency;
    const progress = Math.min(100, (completed / config.totalRequests) * 100);
    process.stdout.write(`\r   Progress: ${progress.toFixed(1)}%`);
  }

  const totalDuration = Date.now() - startTime;

  // Calculate percentiles
  responseTimes.sort((a, b) => a - b);
  const p50 = percentile(responseTimes, 50);
  const p95 = percentile(responseTimes, 95);
  const p99 = percentile(responseTimes, 99);
  const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  const min = Math.min(...responseTimes);
  const max = Math.max(...responseTimes);

  const result: BenchmarkResult = {
    endpoint: config.endpoint,
    totalRequests: config.totalRequests,
    successfulRequests: successCount,
    failedRequests: failCount,
    avgResponseTime: avg,
    p50ResponseTime: p50,
    p95ResponseTime: p95,
    p99ResponseTime: p99,
    minResponseTime: min,
    maxResponseTime: max,
    requestsPerSecond: (config.totalRequests / totalDuration) * 1000,
    errorRate: (failCount / config.totalRequests) * 100,
    totalDuration,
  };

  console.log('\n\n📊 Benchmark Results:');
  console.log(`   Total requests: ${result.totalRequests}`);
  console.log(`   Successful: ${result.successfulRequests}`);
  console.log(`   Failed: ${result.failedRequests}`);
  console.log(`   Error rate: ${result.errorRate.toFixed(2)}%`);
  console.log(`   Duration: ${(result.totalDuration / 1000).toFixed(2)}s`);
  console.log(`   Throughput: ${result.requestsPerSecond.toFixed(2)} req/s`);
  console.log(`\n   Response times (ms):`);
  console.log(`   Min: ${result.minResponseTime}`);
  console.log(`   Avg: ${result.avgResponseTime.toFixed(2)}`);
  console.log(`   P50: ${result.p50ResponseTime}`);
  console.log(`   P95: ${result.p95ResponseTime}`);
  console.log(`   P99: ${result.p99ResponseTime}`);
  console.log(`   Max: ${result.maxResponseTime}`);

  return result;
}

/**
 * Make a single HTTP request
 */
async function makeRequest(config: BenchmarkConfig): Promise<Response> {
  const options: RequestInit = {
    method: config.method,
    headers: config.headers || {},
  };

  if (config.body && config.method !== 'GET') {
    options.body = JSON.stringify(config.body);
    options.headers = {
      ...options.headers,
      'Content-Type': 'application/json',
    };
  }

  return fetch(config.endpoint, options);
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedArray: number[], p: number): number {
  if (sortedArray.length === 0) return 0;

  const index = (p / 100) * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sortedArray[lower];
  }

  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}

/**
 * Compare Worker vs Firebase Functions
 */
export async function comparePerformance(
  workerUrl: string,
  firebaseUrl: string,
  testConfig: Omit<BenchmarkConfig, 'endpoint'>
): Promise<{
  worker: BenchmarkResult;
  firebase: BenchmarkResult;
  improvement: number;
}> {
  console.log('\n🔬 Performance Comparison: Worker vs Firebase Functions\n');

  // Test Worker
  console.log('Testing Cloudflare Worker...');
  const workerResult = await runBenchmark({
    ...testConfig,
    endpoint: workerUrl,
  });

  // Test Firebase
  console.log('\n\nTesting Firebase Functions...');
  const firebaseResult = await runBenchmark({
    ...testConfig,
    endpoint: firebaseUrl,
  });

  // Calculate improvement
  const improvement =
    ((firebaseResult.avgResponseTime - workerResult.avgResponseTime) /
      firebaseResult.avgResponseTime) *
    100;

  console.log('\n\n🏆 Comparison Summary:');
  console.log(`   Worker avg response time: ${workerResult.avgResponseTime.toFixed(2)}ms`);
  console.log(`   Firebase avg response time: ${firebaseResult.avgResponseTime.toFixed(2)}ms`);
  console.log(`   Improvement: ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%`);
  console.log(`\n   Worker P95: ${workerResult.p95ResponseTime}ms`);
  console.log(`   Firebase P95: ${firebaseResult.p95ResponseTime}ms`);
  console.log(`\n   Worker throughput: ${workerResult.requestsPerSecond.toFixed(2)} req/s`);
  console.log(`   Firebase throughput: ${firebaseResult.requestsPerSecond.toFixed(2)} req/s`);

  return {
    worker: workerResult,
    firebase: firebaseResult,
    improvement,
  };
}

/**
 * Load test with gradually increasing concurrency
 */
export async function loadTest(
  endpoint: string,
  config: Omit<BenchmarkConfig, 'endpoint' | 'concurrency'>
): Promise<BenchmarkResult[]> {
  const concurrencyLevels = [1, 10, 50, 100, 200, 500, 1000];
  const results: BenchmarkResult[] = [];

  console.log('\n📈 Load Testing with Increasing Concurrency\n');

  for (const concurrency of concurrencyLevels) {
    const result = await runBenchmark({
      ...config,
      endpoint,
      concurrency,
    });
    results.push(result);

    // Check if error rate is too high
    if (result.errorRate > 5) {
      console.log(`\n⚠️  Error rate exceeded 5% at concurrency ${concurrency}`);
      console.log('   Stopping load test.');
      break;
    }
  }

  return results;
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const WORKER_URL = 'https://checkmatex-worker-production.rohitvinod-dev.workers.dev';

  // Benchmark health endpoint
  runBenchmark({
    endpoint: `${WORKER_URL}/health`,
    method: 'GET',
    concurrency: 50,
    totalRequests: 1000,
    warmupRequests: 10,
  });
}

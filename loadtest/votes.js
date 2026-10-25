// k6 load test: a steady stream of votes from many "clients" (each request has its own
// X-Client-Id, so the per-client rate limit does not kick in).
// With PROCESSING_DELAY_MS on the worker this builds Kafka consumer lag, and KEDA scales the worker out.
//
//   docker run --rm -i -e BASE_URL=http://<address> grafana/k6:2.3.0 run - < loadtest/votes.js
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  scenarios: {
    votes: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  const option = Math.random() < 0.5 ? 'cat' : 'dog';
  const res = http.post(`${BASE_URL}/api/vote`, JSON.stringify({ option }), {
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': `k6-${__VU}-${__ITER}-${Date.now()}`,
    },
  });
  check(res, { 'vote accepted': (r) => r.status === 202 });
}

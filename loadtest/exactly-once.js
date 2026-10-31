// k6 half of loadtest/exactly-once.sh: a steady stream of votes, every client id prefixed with RUN_ID,
// so the check can count exactly this run's votes in PostgreSQL. Prints how many votes were accepted.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const RUN_ID = __ENV.RUN_ID || 'eo-manual';

const accepted = new Counter('votes_accepted');
const rejected = new Counter('votes_rejected');

export const options = {
  scenarios: {
    votes: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 200),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
};

export default function () {
  const option = Math.random() < 0.5 ? 'cat' : 'dog';
  const res = http.post(`${BASE_URL}/api/vote`, JSON.stringify({ option }), {
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': `${RUN_ID}-${__VU}-${__ITER}`,
    },
  });
  // Only a 202 means the vote reached Kafka; anything else must not show up in the database.
  if (check(res, { 'vote accepted': (r) => r.status === 202 })) accepted.add(1);
  else rejected.add(1);
}

export function handleSummary(data) {
  const count = (name) => data.metrics[name]?.values.count ?? 0;
  const p95 = data.metrics.http_req_duration.values['p(95)'].toFixed(1);
  return {
    stdout: `ACCEPTED=${count('votes_accepted')} REJECTED=${count('votes_rejected')} P95_MS=${p95}\n`,
  };
}

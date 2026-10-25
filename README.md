# voting-app

The classic "cats vs dogs" voting app, rebuilt as a small event-driven system on **Kafka + Redis + MongoDB**
and deployed to **AKS, EKS and GKE** from the same GitOps repository.

| Repository | Contents |
|---|---|
| **voting-app** (this one) | Code of the three services, local stack, CI → images in GHCR |
| [voting-gitops](https://github.com/anddr13/voting-gitops) | Helm charts + Argo CD: what runs in the cluster and how |
| [voting-infra-azure](https://github.com/anddr13/voting-infra-azure) | Terraform: AKS |
| [voting-infra-aws](https://github.com/anddr13/voting-infra-aws) | Terraform: EKS |
| [voting-infra-gcp](https://github.com/anddr13/voting-infra-gcp) | Terraform: GKE |

## Architecture

```
browser ──POST /api/vote──▶ vote-api ──produce──▶ Kafka (topic: votes, 6 partitions)
   ▲                          │ rate limit                 │
   │ SSE /api/stream          ▼                            ▼
result-api ◀──SUBSCRIBE──── Redis ◀──HSET + PUBLISH──── worker ──transaction──▶ MongoDB
   └── GET /api/results: from Redis, rebuilt from Mongo when the cache is empty   (votes + tallies)
```

| Service | Responsibility |
|---|---|
| `vote-api` | Validates the vote, rate-limits it (`SET NX EX` in Redis: one vote per client every N seconds), publishes the event to Kafka with an idempotent producer and answers `202` right away. |
| `worker` | Consumes Kafka (consumer group `vote-workers`). In a single MongoDB transaction it inserts the event with `_id = voteId` and `$inc`s the tally, so a redelivered message hits a duplicate key and is not counted twice. Unparseable messages go to `votes-dlq`. After the commit it writes the **absolute** count to Redis and publishes an update. |
| `result-api` | Serves the UI, `/api/results` and live updates over SSE (Redis pub/sub, at most one snapshot per 250 ms). Rebuilds the cache from Mongo when Redis is empty. |

Design choices:
- **Kafka as a buffer.** A burst of votes never hits the database directly: `vote-api` answers immediately and `worker` catches up. In Kubernetes, KEDA scales `worker` on consumer lag.
- **At-least-once delivery + idempotency.** Kafka may redeliver; the unique `voteId` guarantees each vote is counted exactly once.
- **Mongo is the source of truth, Redis is a cache.** Redis can be wiped completely and the counts come back.

The Kafka client is [`@confluentinc/kafka-javascript`](https://github.com/confluentinc/confluent-kafka-javascript)
(librdkafka with a KafkaJS-style API); `kafkajs` itself has not been released since 2023.

## Run locally

```bash
docker compose up -d --build
open http://localhost:8080          # UI
docker compose down -v
```

Compose starts Kafka (KRaft, no ZooKeeper), Redis, MongoDB (a single-node replica set, required for transactions),
the three services, and Caddy acting as the Ingress (`/api/vote` → vote-api, everything else → result-api).

Poking it by hand:

```bash
curl -X POST localhost:8080/api/vote -H 'Content-Type: application/json' -H 'X-Client-Id: me-12345678' -d '{"option":"cat"}'
curl localhost:8080/api/results
curl -N localhost:8080/api/stream
```

### Load test (k6)

```bash
docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6:2.3.0 run - < loadtest/votes.js
```

To watch consumer lag grow (and, in a cluster, KEDA adding workers), slow processing down:
`PROCESSING_DELAY_MS=20 docker compose up -d worker`.

Verified locally: 3,006 votes under load, every one counted exactly once, p95 latency 15 ms, 0 errors.
Redelivered messages, poison messages (→ DLQ) and a full Redis flush were tested as well.

## Tests

```bash
cd services/vote-api && npm ci && npm test     # same for worker and result-api
```

## CI/CD

`.github/workflows/ci.yml`:
1. **test**: `npm ci` + `npm test` for every service.
2. **image**: build, Trivy scan (fails on CRITICAL), push to `ghcr.io/anddr13/voting-<service>:<sha>` and `:latest` (from `main` only).
3. **release**: commits the new image tag to `voting-gitops` (`charts/voting/values.yaml`). Argo CD in every running
   cluster then rolls the version out on its own. CI never talks to the clusters and holds no cloud credentials.

One-time setup:
- Secret `GITOPS_TOKEN`: a fine-grained PAT with **Contents: Read and write** on `voting-gitops` only.
- The clusters pull the images anonymously. Packages pushed from a public repository come out public; if this repo
  is private, make the `voting-*` packages public (GitHub → Packages → Package settings → Change visibility).

> npm 11 no longer runs dependency install scripts by default. The Kafka client needs its script (it downloads
> the prebuilt librdkafka binary), so it is explicitly allowed in `allowScripts` in `package.json`.
> After bumping the package version, renew the approval: `npm install-scripts approve @confluentinc/kafka-javascript`.

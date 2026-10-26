# voting-app

**The entry point of a multi-cloud GitOps project.** The classic "cats vs dogs" voting app, rebuilt as a small
event-driven system on **Kafka + Redis + MongoDB**, and deployed with the **same Helm charts and Argo CD** to
**AKS, EKS, GKE and a local kind cluster**. Each cloud is a pay-per-hour sandbox that is created, load-tested and
destroyed again.

- Exactly-once vote counting on top of at-least-once Kafka delivery (idempotent writes in a MongoDB transaction).
- The worker autoscales on **Kafka consumer lag** with KEDA, measured under load in three environments.
- GitOps end to end: CI never touches a cluster; it bumps an image tag in Git and Argo CD rolls it out everywhere.
- Terraform per cloud, keyless CI (OIDC / federated credentials / Workload Identity), no secrets in GitHub.
- Cost and tear-down hygiene: nightly destroy, budget alerts, and a drain step so nothing Kubernetes created outlives the cluster.

## Repositories

| Repository | What it holds | How it runs |
|---|---|---|
| **voting-app** (this one) | the three services, local stack, load test | CI: test → build → Trivy → GHCR → image tag into voting-gitops |
| [voting-gitops](https://github.com/anddr13/voting-gitops) | Argo CD app of apps, Helm charts (Traefik, KEDA, Strimzi Kafka, Redis, MongoDB, the app), per-cloud overrides | watched by Argo CD in every cluster |
| [voting-infra-azure](https://github.com/anddr13/voting-infra-azure) | Terraform: AKS + Argo CD bootstrap | GitHub Actions, federated credentials, nightly destroy |
| [voting-infra-aws](https://github.com/anddr13/voting-infra-aws) | Terraform: EKS + Argo CD bootstrap | `make up` / `make down` from a laptop (the account's SCPs rule out GitHub OIDC) |
| [voting-infra-gcp](https://github.com/anddr13/voting-infra-gcp) | Terraform: GKE + Argo CD bootstrap | GitHub Actions, Workload Identity Federation, nightly destroy |
| [voting-infra-local](https://github.com/anddr13/voting-infra-local) | kind + Argo CD, the free stand-in | `scripts/up.sh` / `down.sh` on a laptop |

## How it fits together

```
voting-app ── CI: test, build, Trivy scan ──▶ ghcr.io/anddr13/voting-*:<sha>
     └─────── commits the new image tag ──▶ voting-gitops ◀── watched by Argo CD in every cluster
                                                                   │
voting-infra-azure  (GitHub Actions, OIDC)  ── Terraform ──▶ AKS ──┤
voting-infra-gcp    (GitHub Actions, OIDC)  ── Terraform ──▶ GKE ──┤  Argo CD + "root" Application, then waves:
voting-infra-aws    (laptop, aws login)     ── Terraform ──▶ EKS ──┤  traefik/keda/strimzi → kafka/redis/mongo → app
voting-infra-local  (laptop)                ── kind + helm ─▶ kind ─┘
```

The clouds differ only in Terraform and in one small `envs/<cloud>.yaml` (load balancer annotations, StorageClass).

## Results

Same app, same charts, k6 at **200 votes/s for 3 minutes**, every request from a different client id, worker slowed
down with `PROCESSING_DELAY_MS=20` so the lag is visible. Measured 2026-10-26.

| | [kind](https://github.com/anddr13/voting-infra-local#results-measured-2026-10-26) | [AKS](https://github.com/anddr13/voting-infra-azure#results-measured-2026-10-26) | [EKS](https://github.com/anddr13/voting-infra-aws#results-measured-2026-10-26) | GKE |
|---|---|---|---|---|
| Nodes | laptop (Docker) | 2 × D2as_v5 | 2 × m6i.large | code ready, not applied yet |
| Bring-up to a working app | 5 min 23 s | 9 min 34 s | 17 min 36 s | |
| Worker scale-out | 1 → 6 in 37 s | 1 → 6 in 41 s | 1 → 6 in 53 s | |
| Consumer lag under load | grew to 9,251 | flat at ~3,900 | peaked at 5,185, **shrank under load** | |
| Requests / failed | 35,578 / 0 | 36,001 / 0 | 36,000 / 0 | |
| p95 latency | 12 ms (local) | 74 ms (laptop → Sweden) | 78 ms (laptop → Stockholm) | |
| Counted exactly once | ✅ 35,581 | ✅ 36,006 | ✅ 36,004 | |
| Tear-down | seconds | 7 min 50 s, nothing left | 13 min 26 s, nothing left | |

Six workers are the ceiling everywhere: the `votes` topic has 6 partitions. The nodes stayed below 50% CPU on AKS,
so going further means more partitions or batch processing, not a bigger cluster.

## What the real clouds taught

Things that only showed up once it ran for real, all fixed and documented in the repos:

- **KEDA could not reach Kafka** via a short service name: its operator lives in another namespace. Caught on kind, before any money was spent.
- **GitHub's immutable OIDC subjects.** Repositories created after 2026-07-15 send `repo:owner@id/repo@id:...`; the trust in Azure, AWS and GCP now uses the IDs, looked up by Terraform.
- **AKS rewrites webhook configurations** (admissions enforcer), so Argo CD fought it forever until the field was ignored.
- **An Azure trial sees only part of the VM catalogue per region**: no 2-vCPU size at all in northeurope, hence swedencentral.
- **An AWS-managed organization** denies the GitHub OIDC provider and Spot, and "pauses resources" near the spend limit with a `DenyCompute` SCP.
- **GitHub delayed a nightly cron by 4 h 42 min**, so the destroy now runs twice, off the top of the hour.
- **Kubernetes creates cloud resources Terraform does not know about** (load balancers, disks): every destroy drains the cluster first, then checks for leftovers.

## The app

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

### Run locally

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

Verified with compose: 3,006 votes under load, every one counted exactly once, p95 latency 15 ms, 0 errors.
Redelivered messages, poison messages (→ DLQ) and a full Redis flush were tested as well.

### Tests

```bash
cd services/vote-api && npm ci && npm test     # same for worker and result-api
```

### CI/CD

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

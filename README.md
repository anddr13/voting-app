# voting-app

**The entry point of a multi-cloud GitOps project.** The classic "cats vs dogs" voting app, rebuilt as a small
event-driven system on **Kafka + Redis + PostgreSQL**, and deployed with the **same Helm charts and Argo CD** to
**AKS, EKS, GKE and a local kind cluster**. Each cloud is a pay-per-hour sandbox that is created, load-tested and
destroyed again.

- Exactly-once vote counting on top of at-least-once Kafka delivery (`INSERT ... ON CONFLICT DO NOTHING` in PostgreSQL),
  verified with k6 while the consumers are killed with SIGKILL.
- The worker autoscales on **Kafka consumer lag** with KEDA, measured under load in three environments.
- GitOps end to end: CI never touches a cluster; it bumps an image tag in Git and Argo CD rolls it out everywhere.
- Terraform per cloud, keyless CI (OIDC / federated credentials / Workload Identity), no secrets in GitHub.
- Cost and tear-down hygiene: nightly destroy, budget alerts, and a drain step so nothing Kubernetes created outlives the cluster.
- The kind stand is also the "production" that [ai-sre-agent](https://github.com/anddr13/ai-sre-agent) breaks and investigates.

## Repositories

| Repository | What it holds | How it runs |
|---|---|---|
| **voting-app** (this one) | the three services, local stack, load test | CI: test → build → Trivy → GHCR → image tag into voting-gitops |
| [voting-gitops](https://github.com/anddr13/voting-gitops) | Argo CD app of apps, Helm charts (Traefik, KEDA, Strimzi Kafka, Redis, CloudNativePG, the app), per-cloud overrides | watched by Argo CD in every cluster (kind: the `lab` branch) |
| [voting-infra-azure](https://github.com/anddr13/voting-infra-azure) | Terraform: AKS + Argo CD bootstrap | GitHub Actions, federated credentials, nightly destroy |
| [voting-infra-aws](https://github.com/anddr13/voting-infra-aws) | Terraform: EKS + Argo CD bootstrap | `make up` / `make down` from a laptop (the account's SCPs rule out GitHub OIDC) |
| [voting-infra-gcp](https://github.com/anddr13/voting-infra-gcp) | Terraform: GKE + Argo CD bootstrap | GitHub Actions, Workload Identity Federation, nightly destroy |
| [voting-infra-local](https://github.com/anddr13/voting-infra-local) | kind + Argo CD, the free stand-in | `scripts/up.sh` / `down.sh` on a laptop |
| [ai-sre-agent](https://github.com/anddr13/ai-sre-agent) | read-only incident investigation agent, runbooks, chaos scenarios | against the kind stand |

## How it fits together

```
voting-app ── CI: test, build, Trivy scan ──▶ ghcr.io/anddr13/voting-*:<sha>
     └─────── commits the new image tag ──▶ voting-gitops ◀── watched by Argo CD in every cluster
                                                                   │
voting-infra-azure  (GitHub Actions, OIDC)  ── Terraform ──▶ AKS ──┤
voting-infra-gcp    (GitHub Actions, OIDC)  ── Terraform ──▶ GKE ──┤  Argo CD + "root" Application, then waves:
voting-infra-aws    (laptop, aws login)     ── Terraform ──▶ EKS ──┤  traefik/keda/strimzi/cnpg → kafka/redis/postgres → app
voting-infra-local  (laptop)                ── kind + helm ─▶ kind ─┘
```

The clouds differ only in Terraform and in one small `envs/<cloud>.yaml` (load balancer annotations, StorageClass).

## Results

Same app, same charts, k6 at **200 votes/s for 3 minutes**, every request from a different client id, worker slowed
down with `PROCESSING_DELAY_MS=20` so the lag is visible. Measured 2026-10-26, with the MongoDB version of the data
layer (the move to PostgreSQL came later; the Kafka and KEDA side did not change).

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
result-api ◀──SUBSCRIBE──── Redis ◀──HSET + PUBLISH──── worker ──INSERT ... ON CONFLICT──▶ PostgreSQL (primary)
   └── GET /api/results: from Redis, rebuilt from the tallies on the replicas when the cache is empty
```

| Service | Responsibility |
|---|---|
| `vote-api` | Validates the vote, rate-limits it (`SET NX EX` in Redis: one vote per client every N seconds), publishes the event to Kafka with an idempotent producer and answers `202` right away. |
| `worker` | Consumes Kafka (consumer group `vote-workers`). One SQL statement inserts the vote with `ON CONFLICT (vote_id) DO NOTHING` and bumps the tally only if the vote was new, so a redelivered message is not counted twice. Unparseable messages go to `votes-dlq`. Then it writes the **absolute** count to Redis and publishes an update. Exposes `worker_votes_total` (outcome: stored, duplicate, dlq) on `/metrics`. Owns the schema: `migrations/*.sql`, applied by `src/migrate.js` (a PreSync Job in Kubernetes). |
| `result-api` | Serves the UI, `/api/results` and live updates over SSE (Redis pub/sub, at most one snapshot per 250 ms). Rebuilds the cache from PostgreSQL when Redis is empty, reading from the replicas (`voting-pg-ro`). |

The Kafka client is [`@confluentinc/kafka-javascript`](https://github.com/confluentinc/confluent-kafka-javascript)
(librdkafka with a KafkaJS-style API); `kafkajs` itself has not been released since 2023.

## Design decisions

**The scenario:** live voting during a broadcast. Votes arrive in bursts (a few minutes of voting, then silence), and
far more people watch the results than vote. A steady 200 votes/s would need nothing more than one service in front of
PostgreSQL; every extra component is there for the bursts or for the readers.

| Component | What it solves | Without it | Simpler alternative |
|---|---|---|---|
| **Kafka** | Accepting a vote is decoupled from storing it: `vote-api` answers `202` even when the database is slow or down, and a burst waits in the log until the workers drain it. 24 h retention allows a replay; unparseable messages go to a DLQ. | The burst hits the database directly: requests time out and voters see errors. | Redis Streams, a managed queue (SQS, Pub/Sub, Service Bus), or a queue table in PostgreSQL with `FOR UPDATE SKIP LOCKED`. |
| **Redis** | State shared by all replicas: the rate limit (`SET NX EX`) for every `vote-api` pod, a tally cache so readers never reach the database, and pub/sub that tells every `result-api` pod to push an update over SSE. | A per-pod rate limit, bypassed because the load balancer spreads requests; every viewer polls the database. | PostgreSQL `LISTEN/NOTIFY` plus a cache in process memory. |
| **KEDA** | Scales the worker on consumer lag, the signal that actually describes a queue consumer. | A CPU-based HPA misses the backlog: the worker mostly waits on I/O, so CPU stays low while the lag grows. | An HPA on an external metric through Prometheus Adapter: more moving parts, same result. |

**Exactly-once counting is the core of the design.** Kafka delivers at least once: after a worker crash or a consumer
group rebalance, the same message can arrive again. The worker stores a vote with one statement: a CTE inserts it with
`ON CONFLICT (vote_id) DO NOTHING` (`vote_id` is the primary key, set by vote-api) and adds 1 to the tally only for a
row that was actually inserted. A redelivered vote inserts nothing and therefore counts nothing. Redis gets the absolute
count returned by that statement, never an increment, so a repeated cache update is harmless too. On the way in, the
idempotent producer keeps network retries from writing the same message to Kafka twice. `loadtest/exactly-once.sh`
proves it on kind: k6 sends votes, every worker gets SIGKILL mid-run, and `count(*)` must equal the accepted votes.
Two runs in a row: 24,001 and 23,244 votes, each stored exactly once, with 845 and 1,024 redeliveries skipped.

**Why PostgreSQL (it was MongoDB first).** A vote and a tally are fixed-shape rows, and one `INSERT ... ON CONFLICT`
statement gives the exactly-once guarantee without a multi-document transaction (MongoDB needs a replica set even for
that). The first version used MongoDB on purpose, to show a document store next to Kafka and Redis. It moved to
PostgreSQL on CloudNativePG (a primary and a streaming replica) when the stand became the target of
[ai-sre-agent](https://github.com/anddr13/ai-sre-agent): failover, replica lag and connection exhaustion are the
database incidents worth investigating, and every cloud also runs PostgreSQL natively.

**Self-hosted, not managed services.** Kafka (Strimzi), Redis and PostgreSQL (CloudNativePG) run inside the cluster, so the same charts
work on AKS, EKS, GKE and kind, and a sandbox that lives a few hours costs nothing beyond its nodes. In production,
the managed Kafka and Redis that every cloud offers would trade this portability for less operational work.

What a production version would change:
- **Little redundancy in the clouds.** One Kafka broker with replication factor 1, one Redis pod, PostgreSQL with one
  replica: losing a disk loses Kafka data. That keeps a sandbox on two small nodes; production needs 3 brokers with
  `replication.factor=3` and `min.insync.replicas=2` (the kind stand already runs that), backups for PostgreSQL and a
  replicated Redis.
- **The 20 ms processing delay is synthetic.** It stands in for real per-vote work (fraud checks, enrichment) and makes
  the backlog visible in a 3-minute test. Without it a message takes ~10 ms on AKS (~30 ms measured minus the delay),
  so two workers would keep up with 200 votes/s.
- **One vote per transaction.** Processing votes in batches would raise throughput without adding pods. Scaling out
  stops at six workers anyway: the topic has 6 partitions. Partitions can be added later, but that moves keys to
  different partitions, so the number is chosen up front.
- **Results are eventually consistent.** `202` means accepted, not counted yet. Normally the tally catches up within a
  fraction of a second; while a backlog drains, it trails by the consumer lag (thousands of votes in the tests above).
  Fine for a vote, not for a payment.

## Run locally

```bash
docker compose up -d --build
open http://localhost:8080          # UI
docker compose down -v
```

Compose starts Kafka (KRaft, no ZooKeeper), Redis, PostgreSQL, a one-shot `migrate` service for the schema,
the three services, and Caddy acting as the Ingress (`/api/vote` → vote-api, everything else → result-api).

Poking it by hand:

```bash
curl -X POST localhost:8080/api/vote -H 'Content-Type: application/json' -H 'X-Client-Id: me-12345678' -d '{"option":"cat"}'
curl localhost:8080/api/results
curl -N localhost:8080/api/stream
```

## Load test (k6)

```bash
docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6:2.3.0 run - < loadtest/votes.js
```

To watch consumer lag grow (and, in a cluster, KEDA adding workers), slow processing down:
`PROCESSING_DELAY_MS=20 docker compose up -d worker`.

Exactly-once on the kind stand (voting-infra-local), with the workers killed mid-run:

```bash
loadtest/exactly-once.sh                      # RATE=200 DURATION=2m KILL_AFTER=40s by default; exit code 0 = passed
```

It also prints how many redelivered votes the workers skipped (from `worker_votes_total` in Prometheus): the proof
that the kill really caused redeliveries. `kubectl delete pod --force` would not: the kubelet still sends SIGTERM and
the worker commits its offsets on the way out, so the script sends SIGKILL from the kind node instead.

## Tests

```bash
cd services/vote-api && npm ci && npm test     # same for worker and result-api
```

## CI/CD

`.github/workflows/ci.yml`:
1. **test**: `npm ci` + `npm test` for every service.
2. **image**: build, Trivy scan (fails on CRITICAL), push to `ghcr.io/anddr13/voting-<service>:<sha>` and `:latest` (from `main` only).
3. **release**: commits the new image tag to `voting-gitops` (`charts/voting/values.yaml`), on `main` (the clouds)
   and on `lab` (kind). Argo CD in every running cluster then rolls the version out on its own. CI never talks to the clusters and holds no cloud credentials.

One-time setup:
- Secret `GITOPS_TOKEN`: a fine-grained PAT with **Contents: Read and write** on `voting-gitops` only.
- The clusters pull the images anonymously. Packages pushed from a public repository come out public; if this repo
  is private, make the `voting-*` packages public (GitHub → Packages → Package settings → Change visibility).

> npm 11 no longer runs dependency install scripts by default. The Kafka client needs its script (it downloads
> the prebuilt librdkafka binary), so it is explicitly allowed in `allowScripts` in `package.json`.
> After bumping the package version, renew the approval: `npm install-scripts approve @confluentinc/kafka-javascript`.

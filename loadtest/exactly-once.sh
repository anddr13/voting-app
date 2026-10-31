#!/usr/bin/env bash
# Exactly-once check on the kind stand (voting-infra-local):
#   1. k6 sends votes for DURATION, every client id prefixed with a fresh RUN_ID;
#   2. after KILL_AFTER all worker pods are killed (no graceful shutdown), so Kafka redelivers
#      whatever they had processed but not committed yet;
#   3. once the consumers catch up, SELECT count(*) of this run's votes must equal the number of
#      votes k6 got a 202 for, and the tallies must add up to the votes table.
# Exit code 0 = passed.
#
#   loadtest/exactly-once.sh                      # defaults: RATE=200 DURATION=2m KILL_AFTER=40s
#   RATE=500 DURATION=3m loadtest/exactly-once.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RATE=${RATE:-200}
DURATION=${DURATION:-2m}
KILL_AFTER=${KILL_AFTER:-40}
SETTLE_TIMEOUT=${SETTLE_TIMEOUT:-300}
RUN_ID=${RUN_ID:-eo-$(date +%s)}
CLUSTER=voting-local
K6_IMAGE=grafana/k6:2.3.0

kubeconfig="$HOME/.kube/kind-$CLUSTER.yaml"
if command -v cygpath > /dev/null; then kubeconfig=$(cygpath -m "$kubeconfig"); fi # Git Bash on Windows
export KUBECONFIG=${KUBECONFIG:-$kubeconfig}
context=$(kubectl config current-context)
if [ "$context" != "kind-$CLUSTER" ]; then
  echo "Refusing to run: kubectl context is '$context', expected 'kind-$CLUSTER'." >&2
  exit 1
fi

psql() {
  local primary
  primary=$(kubectl -n voting get pod -l cnpg.io/cluster=voting-pg,cnpg.io/instanceRole=primary -o name)
  kubectl -n voting exec "$primary" -c postgres -- psql -d voting -tAc "$1"
}
run_count() { psql "SELECT count(*) FROM votes WHERE client_id LIKE '${RUN_ID}-%'"; }

echo "run $RUN_ID: $RATE votes/s for $DURATION, workers killed after ${KILL_AFTER}s"
k6_out=$(mktemp)
# k6 runs on the kind Docker network and goes straight to Traefik's NodePort, the same path as the browser.
docker run --rm -i --network kind -e BASE_URL=http://$CLUSTER-control-plane:30080 \
  -e RUN_ID="$RUN_ID" -e RATE="$RATE" -e DURATION="$DURATION" \
  "$K6_IMAGE" run --quiet - < loadtest/exactly-once.js > "$k6_out" &
k6_pid=$!

sleep "$KILL_AFTER"
echo "killing workers: $(kubectl -n voting get pod -l app.kubernetes.io/name=worker -o name | tr '\n' ' ')"
kubectl -n voting delete pod -l app.kubernetes.io/name=worker --grace-period=0 --force 2> /dev/null | sed 's/^/  /'

wait "$k6_pid"
summary=$(grep '^ACCEPTED=' "$k6_out")
rm -f "$k6_out"
echo "k6: $summary"
accepted=$(sed -E 's/.*ACCEPTED=([0-9]+).*/\1/' <<< "$summary")

# Wait until every accepted vote is stored, or the count stops moving for a minute.
deadline=$((SECONDS + SETTLE_TIMEOUT))
last=-1
still_since=$SECONDS
while :; do
  stored=$(run_count)
  [ "$stored" -ge "$accepted" ] && break
  if [ "$stored" != "$last" ]; then last=$stored still_since=$SECONDS; fi
  if ((SECONDS - still_since >= 60 || SECONDS >= deadline)); then break; fi
  sleep 5
done
sleep 10 # a late duplicate would show up now, not after the check
stored=$(run_count)

total=$(psql "SELECT count(*) FROM votes")
tallied=$(psql "SELECT coalesce(sum(count), 0) FROM tallies")

echo "accepted by vote-api:  $accepted"
echo "stored for this run:   $stored"
echo "votes table / tallies: $total / $tallied"
if [ "$stored" -eq "$accepted" ] && [ "$total" -eq "$tallied" ]; then
  echo "PASS: every accepted vote stored exactly once"
else
  echo "FAIL" >&2
  exit 1
fi

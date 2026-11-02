#!/usr/bin/env bash
# Exactly-once check in a cloud cluster (AKS, EKS, GKE): the same idea as exactly-once.sh on kind, plus a record of
# how KEDA scales the worker.
#   1. k6 (exactly-once.js) sends votes from this machine to the cluster's load balancer for DURATION;
#   2. after KILL_AFTER every worker process gets SIGKILL. There is no node to `docker exec` into, so a
#      `kubectl debug node` pod (host PID namespace) finds each worker's process by its container ID and kills it;
#   3. SELECT count(*) of this run's votes must equal the votes k6 got a 202 for, and the tallies must add up;
#   4. every 10 s: worker replicas, Kafka consumer lag and node CPU, until AFTER seconds past the load.
# Redeliveries skipped are read from each worker's /metrics: its counters start at the restart after the kill.
# Exit code 0 = passed.
#
#   KUBECONFIG=~/.kube/voting-azure EXPECT=voting-dev-aks loadtest/exactly-once-cloud.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep /opt/... paths for kubectl exec as they are
cd "$(dirname "$0")/.."

RATE=${RATE:-200}
DURATION=${DURATION:-3m}
KILL_AFTER=${KILL_AFTER:-40}
AFTER=${AFTER:-330}
RUN_ID=${RUN_ID:-eo-$(date +%s)}
OUT=${OUT:-loadtest/out/$RUN_ID}
K6_IMAGE=grafana/k6:2.3.0
mkdir -p "$OUT"

# The script kills pods cluster-wide: refuse anything but the cluster named in EXPECT.
context=$(kubectl config current-context)
case "$context" in
  *"${EXPECT:?set EXPECT to (part of) the expected kubectl context}"*) ;;
  *)
    echo "Refusing to run: kubectl context is '$context', expected '$EXPECT'." >&2
    exit 1
    ;;
esac

lb=$(kubectl -n traefik get svc -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}{end}')
echo "context $context, app http://$lb, run $RUN_ID: $RATE votes/s for $DURATION, workers killed after ${KILL_AFTER}s"

broker=$(kubectl -n voting get pod -l strimzi.io/broker-role=true -o name | head -1)
lag() {
  kubectl -n voting exec "$broker" -c kafka -- /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group vote-workers 2> /dev/null |
    awk '$6 ~ /^[0-9]+$/ {s += $6} END {print s + 0}'
}
psql() {
  local primary
  primary=$(kubectl -n voting get pod -l cnpg.io/cluster=voting-pg,cnpg.io/instanceRole=primary -o name)
  kubectl -n voting exec "$primary" -c postgres -- psql -d voting -tAc "$1"
}
run_count() { psql "SELECT count(*) FROM votes WHERE client_id LIKE '${RUN_ID}-%'"; }

t0=$(date +%s)
(
  echo "t_s replicas ready lag node_cpu"
  while :; do
    r=$(kubectl -n voting get deploy worker -o jsonpath='{.spec.replicas} {.status.readyReplicas}')
    cpu=$(kubectl top nodes --no-headers 2> /dev/null | awk '{printf "%s/", $3}' || true) # EKS has no metrics-server
    echo "$(($(date +%s) - t0)) ${r:-? ?} $(lag) ${cpu%/}"
    sleep 10
  done
) > "$OUT/samples.txt" 2>&1 &
sampler=$!
trap 'kill $sampler 2> /dev/null || true' EXIT

docker run --rm -i -e BASE_URL="http://$lb" -e RUN_ID="$RUN_ID" -e RATE="$RATE" -e DURATION="$DURATION" \
  "$K6_IMAGE" run --quiet - < loadtest/exactly-once.js > "$OUT/k6.txt" 2>&1 &
k6_pid=$!

sleep "$KILL_AFTER"
# Not `kubectl delete pod --force`: the kubelet still sends SIGTERM first and the worker commits its offsets on the
# way out. One debug pod per worker, all started at once; `kubectl debug -i` drops the output, so it is read from the logs.
echo "SIGKILL to every worker process at +$(($(date +%s) - t0))s:" | tee "$OUT/kill.txt"
debuggers=()
for pod in $(kubectl -n voting get pod -l app.kubernetes.io/name=worker --field-selector=status.phase=Running -o name); do
  node=$(kubectl -n voting get "$pod" -o jsonpath='{.spec.nodeName}')
  cid=$(kubectl -n voting get "$pod" -o jsonpath='{.status.containerStatuses[0].containerID}')
  cid=${cid#*://}
  [ -n "$cid" ] || continue
  debuggers+=("$(kubectl debug "node/$node" --profile=sysadmin --image=busybox:1.37 -- sh -c "
    for p in /proc/[0-9]*; do
      grep -q '$cid' \$p/cgroup 2>/dev/null && grep -q src/index.js \$p/cmdline 2>/dev/null &&
        kill -9 \${p#/proc/} && echo '  ${pod#pod/} pid' \${p#/proc/}
    done; true" 2>&1 | sed -nE 's/.*pod (node-debugger-[^ ]+).*/\1/p' | head -1)")
done
for d in "${debuggers[@]}"; do
  kubectl -n default wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$d" --timeout=90s > /dev/null || true
  kubectl -n default logs "$d" | tee -a "$OUT/kill.txt"
  kubectl -n default delete pod "$d" --wait=false > /dev/null
done

wait "$k6_pid"
load_end=$(($(date +%s) - t0))
echo "k6: $(cat "$OUT/k6.txt")"
accepted=$(sed -nE 's/.*ACCEPTED=([0-9]+).*/\1/p' "$OUT/k6.txt")

# Wait until every accepted vote is stored, or the count stops moving for a minute.
last=-1
still_since=$SECONDS
while :; do
  stored=$(run_count)
  [ "$stored" -ge "$accepted" ] && break
  if [ "$stored" != "$last" ]; then last=$stored still_since=$SECONDS; fi
  ((SECONDS - still_since >= 60)) && break
  sleep 5
done
sleep 10 # a late duplicate would show up now, not after the check
stored=$(run_count)
total=$(psql "SELECT count(*) FROM votes")
tallied=$(psql "SELECT coalesce(sum(count), 0) FROM tallies")

echo "redeliveries skipped per worker (counters since the restart):"
for p in $(kubectl -n voting get pod -l app.kubernetes.io/name=worker -o name); do
  echo -n "  ${p#pod/} "
  kubectl -n voting exec "$p" -- node -e "fetch('http://localhost:8080/metrics').then(r => r.text())
    .then(t => console.log((t.match(/worker_votes_total\{outcome=\"duplicate\"\} (\d+)/) || [, '?'])[1]))"
done | tee "$OUT/duplicates.txt"

echo "load ended at:         +${load_end}s"
echo "accepted by vote-api:  $accepted"
echo "stored for this run:   $stored"
echo "votes table / tallies: $total / $tallied"
if [ "$stored" -eq "$accepted" ] && [ "$total" -eq "$tallied" ]; then
  result=PASS
  echo "PASS: every accepted vote stored exactly once"
else
  result=FAIL
  echo "FAIL" >&2
fi

# Keep sampling to see KEDA scale the worker back in.
while (($(date +%s) - t0 < load_end + AFTER)); do sleep 10; done
kill $sampler 2> /dev/null || true
echo "samples ($OUT/samples.txt):"
cat "$OUT/samples.txt"
[ "$result" = PASS ]

#!/usr/bin/env bash
# Manual scaling script for cost control on the development/staging cluster.
#
# Usage:
#   ./scripts/manual-scale.sh up    # resume normal autoscaling (work hours)
#   ./scripts/manual-scale.sh down  # pause autoscalers + scale workers to 0
#
# What this does:
#   DOWN  Pauses all KEDA scalers so workers don't spawn even if Redis has
#         queued jobs, and scales every worker / selenium-node deployment
#         to 0. The dedicated worker node pools then drain to their floor
#         (DO node pool min = 1 node each) which is the cheapest state we
#         can hold without deleting the pools.
#   UP    Reverses DOWN. Removes the KEDA paused annotation; from there
#         KEDA observes queue depth and selenium-grid load and spawns the
#         right number of worker/browser pods on demand. No deployments are
#         pre-scaled because that would burn idle node capacity.
#
# Cluster layout (see infra/kubernetes/architecture.md):
#   tesbox-exec-4cpu   2 nodes (system: KEDA, CoreDNS, selenium control plane)
#   pool-playwright    autoscale 1-5  (all Playwright workers, tainted)
#   pool-selenium      autoscale 1-5  (selenium-node-chrome/firefox +
#                                       Selenium workers, tainted)

set -euo pipefail

NAMESPACE="tesbo-execution"
ACTION="${1:-}"

# Worker deployments managed by KEDA (Playwright JS/TS/Java/Python + Selenium Java/Python).
WORKER_DEPLOYMENTS=(
  "execution-worker"
  "execution-worker-java"
  "execution-worker-python"
  "execution-worker-selenium-java"
  "execution-worker-selenium-python"
)

# Matching KEDA ScaledObjects for the worker deployments above.
WORKER_SCALERS=(
  "execution-worker-scaler"
  "execution-worker-java-scaler"
  "execution-worker-python-scaler"
  "execution-worker-selenium-java-scaler"
  "execution-worker-selenium-python-scaler"
)

# Selenium browser deployments + their KEDA scaler.
SELENIUM_BROWSER_DEPLOYMENTS=(
  "selenium-node-chrome"
  "selenium-node-firefox"
)
SELENIUM_BROWSER_SCALERS=(
  "selenium-node-chrome-scaler"
)

if [[ "$ACTION" != "up" && "$ACTION" != "down" ]]; then
  echo "Usage: $0 [up|down]"
  echo "  up   - Resume normal autoscaling (KEDA decides replica counts)"
  echo "  down - Pause autoscalers and scale workers to 0 (save costs)"
  exit 1
fi

pause_scaler() {
  local scaler="$1"
  kubectl annotate scaledobject "$scaler" -n "$NAMESPACE" \
    autoscaling.keda.sh/paused-replicas=0 --overwrite
}

resume_scaler() {
  local scaler="$1"
  kubectl annotate scaledobject "$scaler" -n "$NAMESPACE" \
    autoscaling.keda.sh/paused-replicas- --overwrite >/dev/null 2>&1 || true
}

if [[ "$ACTION" == "up" ]]; then
  echo "Scaling UP - resuming KEDA autoscalers..."

  # Resume worker scalers - KEDA will spawn pods as Redis queue depth dictates.
  for scaler in "${WORKER_SCALERS[@]}"; do
    resume_scaler "$scaler"
  done

  # Resume Selenium browser scalers - KEDA spawns chrome/firefox nodes when
  # selenium-grid trigger sees queued sessions OR Selenium workers come up.
  for scaler in "${SELENIUM_BROWSER_SCALERS[@]}"; do
    resume_scaler "$scaler"
  done

  echo "Scaled UP - autoscalers active. Pods will spawn on demand."

elif [[ "$ACTION" == "down" ]]; then
  echo "Scaling DOWN - pausing KEDA and draining workers..."

  # Pause worker scalers so KEDA won't fight us when we scale deployments to 0.
  for scaler in "${WORKER_SCALERS[@]}"; do
    pause_scaler "$scaler"
  done

  # Pause Selenium browser scalers.
  for scaler in "${SELENIUM_BROWSER_SCALERS[@]}"; do
    pause_scaler "$scaler"
  done

  # Scale worker deployments to 0.
  for deploy in "${WORKER_DEPLOYMENTS[@]}"; do
    kubectl scale deployment "$deploy" --replicas=0 -n "$NAMESPACE"
  done

  # Scale Selenium browser deployments to 0. Control plane
  # (router, distributor, event-bus, queue, sessions, proxy) stays running
  # because grid.tesbogrid.com must remain reachable.
  for deploy in "${SELENIUM_BROWSER_DEPLOYMENTS[@]}"; do
    kubectl scale deployment "$deploy" --replicas=0 -n "$NAMESPACE"
  done

  echo "Scaled DOWN - worker pools will drain to 1 node each (DO pool minimum)."
fi

echo
echo "Node pools:"
kubectl get nodes -L workload --no-headers | awk '{printf "  %-30s %s\n", $1, $6}'

echo
echo "Worker / browser replica counts:"
kubectl get deploy -n "$NAMESPACE" \
  execution-worker execution-worker-java execution-worker-python \
  execution-worker-selenium-java execution-worker-selenium-python \
  selenium-node-chrome selenium-node-firefox \
  -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas 2>/dev/null

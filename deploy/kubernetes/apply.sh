#!/usr/bin/env bash
# Apply all Kubernetes manifests to the cluster.
# Run this after every deployment to ensure the cluster reflects the latest infra/*.yaml changes.
# Prerequisites: kubectl configured and pointing at the target cluster.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K8S_DIR="$REPO_ROOT/infra/kubernetes"

echo "▸ Applying namespace"
kubectl apply -f "$K8S_DIR/namespace.yaml"

echo "▸ Applying Selenium Grid (hub + nodes)"
kubectl apply -f "$K8S_DIR/selenium-hub-deployment.yaml"
kubectl apply -f "$K8S_DIR/selenium-hub-service.yaml"
kubectl apply -f "$K8S_DIR/selenium-node-chrome-deployment.yaml"
kubectl apply -f "$K8S_DIR/selenium-node-firefox-deployment.yaml"

echo "▸ Applying worker deployments"
kubectl apply -f "$K8S_DIR/worker-deployment.yaml"
kubectl apply -f "$K8S_DIR/worker-deployment-java.yaml"
kubectl apply -f "$K8S_DIR/worker-deployment-python.yaml"
kubectl apply -f "$K8S_DIR/worker-deployment-selenium-java.yaml"
kubectl apply -f "$K8S_DIR/worker-deployment-selenium-python.yaml"

echo "▸ Applying KEDA ScaledObjects"
# activationListLength must be "0" so a single queued job triggers scale-up.
# Setting it to "1" (old default) uses strict > comparison, so a 1-job run never activates workers.
kubectl apply -f "$K8S_DIR/worker-scaledobject.yaml"
kubectl apply -f "$K8S_DIR/worker-scaledobject-java.yaml"
kubectl apply -f "$K8S_DIR/worker-scaledobject-python.yaml"
kubectl apply -f "$K8S_DIR/worker-scaledobject-selenium-java.yaml"
kubectl apply -f "$K8S_DIR/worker-scaledobject-selenium-python.yaml"

echo "▸ Applying execution-api service"
kubectl apply -f "$K8S_DIR/api-deployment.yaml"

echo "✓ All Kubernetes manifests applied"
echo ""
echo "Verify ScaledObjects:"
kubectl get scaledobject -n tesbo-execution

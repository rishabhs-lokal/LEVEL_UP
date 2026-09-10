#!/usr/bin/env sh
# Reference deploy sequence: namespace/config first, then migrations to
# completion, then the app rollout. Run manually or wire into CI as-is.
#
# Requires: eaze-level-up-secrets already created in the eaze namespace
# (see k8s/secret.example.yaml for the expected keys).
set -eu

NAMESPACE=eaze
JOB_NAME=eaze-level-up-migrate

echo "Applying namespace, config, and service..."
kubectl apply -k k8s/

echo "Re-running migrations for this deploy..."
kubectl delete job/"$JOB_NAME" -n "$NAMESPACE" --ignore-not-found
kubectl apply -f k8s/migration-job.yaml
kubectl wait --for=condition=complete job/"$JOB_NAME" -n "$NAMESPACE" --timeout=120s

echo "Migrations complete — rolling out the app deployment..."
kubectl apply -f k8s/deployment.yaml
kubectl rollout status deployment/eaze-level-up -n "$NAMESPACE"

echo "Deploy complete."

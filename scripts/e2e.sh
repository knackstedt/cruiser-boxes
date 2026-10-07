#!/usr/bin/env bash
# e2e.sh — headless smoke test: doctor, create, start, QMP probe, kill, rm.
# Creates a blank-disk VM (no provisioning) — proves the QEMU/QMP pipeline.
# Usage: ./scripts/e2e.sh [name]   (default vm name: e2e-<pid>)
set -euo pipefail
cd "$(dirname "$0")/.."

CLI="bun run src/cli.ts"
VM="${1:-e2e-$$}"

cleanup() { $CLI vm rm "$VM" --disk >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== doctor =="
$CLI doctor || true   # non-fatal: some tools optional

echo "== toolchain check =="
$CLI toolchain check || true

echo "== create $VM =="
$CLI vm create "$VM" --cpus 2 --mem 2048 --disk 8

echo "== args =="
$CLI vm args "$VM" | head -5

echo "== start =="
$CLI vm start "$VM"

echo "== status =="
$CLI vm status "$VM"

echo "== kill =="
$CLI vm kill "$VM"

echo "== rm =="
$CLI vm rm "$VM" --disk
trap - EXIT
echo "PASS"

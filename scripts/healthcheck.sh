#!/bin/bash
# LabFlow API Post-Deploy Healthcheck
# Checks critical endpoints after Render deployment

API_URL="https://labflow-api.onrender.com"
FAIL=0

check() {
  local name="$1"
  local url="$2"
  local expected="${3:-200}"

  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$url")
  if [ "$status" = "$expected" ]; then
    echo "â $name â $status"
  else
    echo "â $name â got $status, expected $expected"
    FAIL=1
  fi
}

echo "=== LabFlow API Healthcheck ==="
echo "Target: $API_URL"
echo ""

# Core endpoints
check "GET /health" "$API_URL/health"
check "GET /api/lab" "$API_URL/api/lab" "401"
check "GET /api/voice/personas" "$API_URL/api/voice/personas"
check "GET /api/papers/alerts" "$API_URL/api/papers/alerts" "401"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "ð All healthchecks passed!"
  exit 0
else
  echo "â ï¸ Some healthchecks failed!"
  exit 1
fi


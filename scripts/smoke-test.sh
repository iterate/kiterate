#!/usr/bin/env bash
#
# Event Stream Smoke Test
# 
# Tests the basic event stream server with:
# - Two concurrent SSE consumers
# - Two separate writers
# - Offset parameter (offset=-1, offset=<specific>)
# - Implicit stream creation
#
# Usage: ./scripts/smoke-test.sh [server-name]
#
# Arguments:
#   server-name   Name of server in server/ directory (default: basic)
#                 Available: basic, basic-with-pi
#
# Examples:
#   ./scripts/smoke-test.sh              # Test basic
#   ./scripts/smoke-test.sh basic
#   ./scripts/smoke-test.sh basic-with-pi
#

set -euo pipefail

# Disable job control messages
set +m

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Track PIDs for cleanup
PIDS=()
TEMP_FILES=()

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Event Stream Smoke Test"
    echo ""
    echo "Usage: $0 [server-name]"
    echo ""
    echo "Arguments:"
    echo "  server-name   Name of server in server/ directory"
    echo "                Default: basic"
    echo ""
    echo "Available servers:"
    for dir in "$PROJECT_ROOT"/server/*/; do
        name=$(basename "$dir")
        echo "  - $name"
    done
    echo ""
    echo "Examples:"
    echo "  $0                    # Test basic"
    echo "  $0 basic              # Test basic"
    echo "  $0 basic-with-pi      # Test basic-with-pi"
    exit 0
fi

SERVER_NAME="${1:-basic}"

# Map server name to pnpm filter name
get_pnpm_filter() {
    case "$1" in
        basic) echo "@kiterate/server-basic" ;;
        basic-with-pi) echo "@kiterate/server-basic-with-pi" ;;
        *) echo "" ;;
    esac
}

# Validate server name
if [[ ! -d "$PROJECT_ROOT/server/$SERVER_NAME" ]]; then
    echo -e "${RED}Error: Server '$SERVER_NAME' not found${NC}"
    echo ""
    echo "Available servers:"
    for dir in "$PROJECT_ROOT"/server/*/; do
        name=$(basename "$dir")
        echo "  - $name"
    done
    echo ""
    echo "Usage: $0 [server-name]"
    exit 1
fi

# Get the pnpm filter for this server
PNPM_FILTER=$(get_pnpm_filter "$SERVER_NAME")
if [[ -z "$PNPM_FILTER" ]]; then
    echo -e "${RED}Error: No pnpm filter configured for '$SERVER_NAME'${NC}"
    echo "Add it to the get_pnpm_filter function in this script."
    exit 1
fi

cleanup() {
    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    # Kill all background processes (don't wait, just kill)
    {
        for pid in "${PIDS[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
        
        # Give them a moment to die
        sleep 0.3
        
        # Force kill any remaining
        for pid in "${PIDS[@]}"; do
            kill -9 "$pid" 2>/dev/null || true
        done
        
        # Wait to reap zombies
        wait 2>/dev/null || true
    } 2>/dev/null
    
    # Remove temp files
    for f in "${TEMP_FILES[@]}"; do
        rm -f "$f" 2>/dev/null || true
    done
    
    echo -e "${GREEN}Cleanup complete.${NC}"
}

trap cleanup EXIT

# Find a random free port
find_free_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()'
}

# Print section header
section() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}${BOLD}$1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
}

# Print test header
test_header() {
    echo ""
    echo -e "${CYAN}▶ $1${NC}"
}

# Pass/fail helpers
pass() {
    echo -e "${GREEN}  ✓ $1${NC}"
}

fail() {
    echo -e "${RED}  ✗ $1${NC}"
    exit 1
}

check() {
    if [ $? -eq 0 ]; then
        pass "$1"
    else
        fail "$1"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Test setup
# ─────────────────────────────────────────────────────────────────────────────

section "1. Starting Server ($SERVER_NAME)"

PORT=$(find_free_port)
BASE_URL="http://127.0.0.1:$PORT"
STREAM_NAME="test-stream-$(date +%s)"
STREAM_URL="$BASE_URL/agents/$STREAM_NAME"

echo "Port: $PORT"
echo "Base URL: $BASE_URL"
echo "Stream: $STREAM_NAME"

# Create temp files for consumer output
CONSUMER1_OUT=$(mktemp)
CONSUMER2_OUT=$(mktemp)
TEMP_FILES+=("$CONSUMER1_OUT" "$CONSUMER2_OUT")

# Start server in background
PORT=$PORT pnpm --filter "$PNPM_FILTER" start > /dev/null 2>&1 &
SERVER_PID=$!
PIDS+=($SERVER_PID)

echo "Server PID: $SERVER_PID"

# Wait for server to be ready
echo "Waiting for server to start..."
for i in {1..30}; do
    if curl -s "$BASE_URL" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        fail "Server process died"
    fi
    sleep 0.2
done

# Verify server is running
if kill -0 $SERVER_PID 2>/dev/null; then
    pass "Server started on port $PORT"
else
    fail "Server failed to start"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test: Stream creation is implicit
# ─────────────────────────────────────────────────────────────────────────────

section "2. Testing Implicit Stream Creation"

test_header "POST creates stream implicitly"
RESPONSE=$(curl -s -X POST "$STREAM_URL" \
    -H "Content-Type: application/json" \
    -d '{"type":"init","text":"First event"}' \
    -w "\n%{http_code}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "200" ]; then
    pass "Stream created implicitly on first POST (HTTP 200)"
else
    fail "Expected HTTP 200, got $HTTP_CODE"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test: SSE Consumers
# ─────────────────────────────────────────────────────────────────────────────

section "3. Starting Two Concurrent Consumers (SSE)"

test_header "Consumer 1: GET $STREAM_URL?offset=-1&live=sse"
curl -s -N "$STREAM_URL?offset=-1&live=sse" > "$CONSUMER1_OUT" 2>&1 &
CONSUMER1_PID=$!
PIDS+=($CONSUMER1_PID)
echo "    Consumer 1 PID: $CONSUMER1_PID"

test_header "Consumer 2: GET $STREAM_URL?offset=-1&live=sse"  
curl -s -N "$STREAM_URL?offset=-1&live=sse" > "$CONSUMER2_OUT" 2>&1 &
CONSUMER2_PID=$!
PIDS+=($CONSUMER2_PID)
echo "    Consumer 2 PID: $CONSUMER2_PID"

# Give consumers time to connect
sleep 1

if kill -0 $CONSUMER1_PID 2>/dev/null && kill -0 $CONSUMER2_PID 2>/dev/null; then
    pass "Both consumers connected"
else
    fail "Consumer(s) failed to connect"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test: Multiple Writers
# ─────────────────────────────────────────────────────────────────────────────

section "4. Sending Events from Two Writers"

test_header "Writer 1: Event 1"
curl -s -X POST "$STREAM_URL" \
    -H "Content-Type: application/json" \
    -d '{"type":"message","from":"writer1","seq":1,"text":"Hello from Writer 1!"}'
check "Writer 1 sent event 1"

test_header "Writer 2: Event 1"
curl -s -X POST "$STREAM_URL" \
    -H "Content-Type: application/json" \
    -d '{"type":"message","from":"writer2","seq":1,"text":"Hello from Writer 2!"}'
check "Writer 2 sent event 1"

test_header "Writer 1: Event 2"
curl -s -X POST "$STREAM_URL" \
    -H "Content-Type: application/json" \
    -d '{"type":"message","from":"writer1","seq":2,"text":"Second from Writer 1"}'
check "Writer 1 sent event 2"

test_header "Writer 2: Event 2"
curl -s -X POST "$STREAM_URL" \
    -H "Content-Type: application/json" \
    -d '{"type":"message","from":"writer2","seq":2,"text":"Second from Writer 2"}'
check "Writer 2 sent event 2"

# Wait for events to propagate
sleep 0.5

# ─────────────────────────────────────────────────────────────────────────────
# Test: Consumer Verification
# ─────────────────────────────────────────────────────────────────────────────

section "5. Verifying Consumers Received Events"

test_header "Checking Consumer 1 output"
CONSUMER1_EVENTS=$(grep -c '"from":"writer' "$CONSUMER1_OUT" 2>/dev/null || echo "0")
echo "    Events received: $CONSUMER1_EVENTS"
if [ "$CONSUMER1_EVENTS" -ge 4 ]; then
    pass "Consumer 1 received all 4 events"
else
    fail "Consumer 1 missing events (got $CONSUMER1_EVENTS, expected 4)"
fi

test_header "Checking Consumer 2 output"
CONSUMER2_EVENTS=$(grep -c '"from":"writer' "$CONSUMER2_OUT" 2>/dev/null || echo "0")
echo "    Events received: $CONSUMER2_EVENTS"
if [ "$CONSUMER2_EVENTS" -ge 4 ]; then
    pass "Consumer 2 received all 4 events"
else
    fail "Consumer 2 missing events (got $CONSUMER2_EVENTS, expected 4)"
fi

# Show sample output from consumers
echo ""
echo -e "${CYAN}    Sample from Consumer 1:${NC}"
grep "event: data" -A1 "$CONSUMER1_OUT" | head -6 | sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────
# Test: Offset Parameter
# ─────────────────────────────────────────────────────────────────────────────

section "6. Testing Offset Parameter"

test_header "offset=-1 (read from beginning)"
RESULT=$(curl -s "$STREAM_URL?offset=-1")
EVENT_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
echo "    Events returned: $EVENT_COUNT"
if [ "$EVENT_COUNT" -eq 5 ]; then
    pass "offset=-1 returns all 5 events (init + 4 messages)"
else
    fail "offset=-1 returned $EVENT_COUNT events (expected 5)"
fi

# Get an offset from the results
FIRST_OFFSET=$(echo "$RESULT" | python3 -c "import sys,json; data=json.load(sys.stdin); print(data[0].get('offset', ''))" 2>/dev/null || echo "")
echo "    First event offset: $FIRST_OFFSET"

if [ -n "$FIRST_OFFSET" ]; then
    test_header "offset=<specific> (resume from middle)"
    RESULT=$(curl -s "$STREAM_URL?offset=$FIRST_OFFSET")
    PARTIAL_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "    Events from offset $FIRST_OFFSET: $PARTIAL_COUNT"
    if [ "$PARTIAL_COUNT" -gt 0 ] && [ "$PARTIAL_COUNT" -lt 5 ]; then
        pass "Partial read from specific offset works"
    elif [ "$PARTIAL_COUNT" -eq 4 ]; then
        pass "Read from first offset returns remaining 4 events"
    else
        fail "Unexpected result from specific offset (got $PARTIAL_COUNT)"
    fi
else
    echo -e "${YELLOW}  ⚠ Skipping specific offset test (no offset found)${NC}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Test: Events contain offset
# ─────────────────────────────────────────────────────────────────────────────

section "7. Verifying Events Contain Offset"

test_header "Check events have offset field"
HAS_OFFSET=$(echo "$RESULT" | python3 -c "import sys,json; data=json.load(sys.stdin); print('yes' if all('offset' in e for e in data) else 'no')" 2>/dev/null || echo "no")
if [ "$HAS_OFFSET" = "yes" ]; then
    pass "All events contain offset field"
else
    fail "Events missing offset field"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Final Summary
# ─────────────────────────────────────────────────────────────────────────────

section "8. Final Verification"

test_header "Reading all events"
FINAL_RESULT=$(curl -s "$STREAM_URL?offset=-1")
FINAL_COUNT=$(echo "$FINAL_RESULT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
echo "    Total events in stream: $FINAL_COUNT"

echo ""
echo -e "${CYAN}    All events:${NC}"
echo "$FINAL_RESULT" | python3 -m json.tool 2>/dev/null | head -40 | sed 's/^/    /'

if [ "$FINAL_COUNT" -eq 5 ]; then
    pass "Stream contains all 5 events"
else
    fail "Expected 5 events, got $FINAL_COUNT"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Success
# ─────────────────────────────────────────────────────────────────────────────

section "Summary"

echo ""
echo -e "${GREEN}${BOLD}All tests passed!${NC}"
echo ""
echo "Server: $SERVER_NAME"
echo "Verified:"
echo "  • Implicit stream creation on POST"
echo "  • 2 concurrent SSE consumers received all events"
echo "  • 2 writers successfully appended events"
echo "  • offset=-1 and offset=<specific> work correctly"
echo "  • Events contain offset field"
echo ""

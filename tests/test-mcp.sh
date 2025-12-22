#!/bin/bash
# Test Engram MCP server with fictional examples

cd "$(dirname "$0")/.."

echo "=== Testing Engram MCP Server ==="
echo ""

# Function to send JSON-RPC request
send_request() {
    local request="$1"
    echo "$request" | node dist/index.js 2>/dev/null | grep -v '^\[' | head -1
}

# Test 1: Stats (empty)
echo "1. Testing stats (empty database)..."
STATS=$(send_request '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stats","arguments":{}}}')
echo "Response: $STATS"
echo ""

# Test 2: Remember a memory about Sarah
echo "2. Testing remember (Sarah memory)..."
REMEMBER1=$(send_request '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remember","arguments":{"content":"Sarah Chen is the VP of Engineering at Acme Corp. She is allergic to shellfish and prefers window seats on flights.","importance":0.9}}}')
echo "Response: $REMEMBER1"
echo ""

# Test 3: Remember another memory
echo "3. Testing remember (Sarah work preferences)..."
REMEMBER2=$(send_request '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{"content":"Sarah prefers async communication over meetings. She blocks her calendar before 10am for deep work.","importance":0.8}}}')
echo "Response: $REMEMBER2"
echo ""

# Test 4: Remember about John
echo "4. Testing remember (John memory)..."
REMEMBER3=$(send_request '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"remember","arguments":{"content":"John Martinez is a senior developer who reports to Sarah. He is an expert in backend systems."}}}')
echo "Response: $REMEMBER3"
echo ""

# Test 5: Create explicit relationship
echo "5. Testing relate (John and Sarah)..."
RELATE=$(send_request '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"relate","arguments":{"from":"John Martinez","to":"Sarah Chen","relation":"reports_to"}}}')
echo "Response: $RELATE"
echo ""

# Test 6: Add observation
echo "6. Testing observe (Sarah allergy)..."
OBSERVE=$(send_request '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"observe","arguments":{"entity":"Sarah Chen","observation":"Has severe shellfish allergy - avoid seafood restaurants"}}}')
echo "Response: $OBSERVE"
echo ""

# Test 7: Query entity
echo "7. Testing query_entity (Sarah)..."
QUERY=$(send_request '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"query_entity","arguments":{"entity":"Sarah Chen"}}}')
echo "Response: $QUERY"
echo ""

# Test 8: Recall - semantic search
echo "8. Testing recall (Sarah work preferences)..."
RECALL1=$(send_request '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"recall","arguments":{"query":"How does Sarah prefer to work and communicate?"}}}')
echo "Response: $RECALL1"
echo ""

# Test 9: Recall - context search
echo "9. Testing recall (team lunch planning)..."
RECALL2=$(send_request '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"recall","arguments":{"query":"What should I know when planning a team lunch?"}}}')
echo "Response: $RECALL2"
echo ""

# Test 10: List entities
echo "10. Testing list_entities..."
LIST=$(send_request '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_entities","arguments":{"type":"person"}}}')
echo "Response: $LIST"
echo ""

# Test 11: Final stats
echo "11. Testing stats (after adding data)..."
FINAL_STATS=$(send_request '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"stats","arguments":{}}}')
echo "Response: $FINAL_STATS"
echo ""

echo "=== All tests completed ==="

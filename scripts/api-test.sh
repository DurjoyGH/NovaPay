#!/usr/bin/env bash

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.yml}"
DB_SERVICE="${DB_SERVICE:-postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-novapay}"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

RESPONSE_STATUS=""
RESPONSE_BODY=""

uuid() {
  cat /proc/sys/kernel/random/uuid
}

json_get() {
  local json="$1"
  local path="$2"
  printf "%s" "$json" | node -e '
let data = "";
process.stdin.on("data", (d) => data += d);
process.stdin.on("end", () => {
  try {
    const obj = JSON.parse(data || "{}");
    const parts = process.argv[1].split(".");
    let cur = obj;
    for (const p of parts) {
      cur = cur?.[p];
    }
    if (cur === undefined || cur === null) {
      process.exit(2);
    }
    if (typeof cur === "object") {
      process.stdout.write(JSON.stringify(cur));
      return;
    }
    process.stdout.write(String(cur));
  } catch (e) {
    process.exit(2);
  }
});
' "$path"
}

log_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $1"
}

log_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $1"
  if [ -n "${2:-}" ]; then
    echo "      $2"
  fi
}

log_skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  echo "SKIP: $1"
  if [ -n "${2:-}" ]; then
    echo "      $2"
  fi
}

call_api() {
  local method="$1"
  local path="$2"
  local data="$3"
  shift 3

  local tmp
  tmp=$(mktemp)

  if [ "$data" = "__NO_BODY__" ]; then
    RESPONSE_STATUS=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path" "$@")
  else
    RESPONSE_STATUS=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path" -H "Content-Type: application/json" -d "$data" "$@")
  fi

  RESPONSE_BODY=$(cat "$tmp")
  rm -f "$tmp"
}

assert_status() {
  local expected="$1"
  local title="$2"
  if [ "$RESPONSE_STATUS" = "$expected" ]; then
    log_pass "$title"
  else
    log_fail "$title" "expected status $expected, got $RESPONSE_STATUS, body=$RESPONSE_BODY"
  fi
}

assert_body_contains() {
  local token="$1"
  local title="$2"
  if printf "%s" "$RESPONSE_BODY" | grep -q "$token"; then
    log_pass "$title"
  else
    log_fail "$title" "response does not contain $token, body=$RESPONSE_BODY"
  fi
}

assert_int_eq() {
  local expected="$1"
  local actual="$2"
  local title="$3"
  if [ "$expected" -eq "$actual" ]; then
    log_pass "$title"
  else
    log_fail "$title" "expected $expected, got $actual"
  fi
}

run_sql() {
  local sql="$1"
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "$sql"
}

run_sql_file() {
  local file_path="$1"
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$file_path"
}

ensure_schema() {
  local count
  count=$(run_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallets','idempotency_keys','fx_quotes','transfers','ledger_entries');" | tr -d '[:space:]')

  if [ "${count:-0}" -lt 5 ]; then
    echo "Schema missing or incomplete. Bootstrapping from shared/db/init/*.sql ..."
    run_sql_file "shared/db/init/001_extensions.sql"
    run_sql_file "shared/db/init/002_core_tables.sql"
    run_sql_file "shared/db/init/003_indexes.sql"
  fi

  count=$(run_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('wallets','idempotency_keys','fx_quotes','transfers','ledger_entries');" | tr -d '[:space:]')
  if [ "${count:-0}" -lt 5 ]; then
    echo "Schema bootstrap failed. Expected 5 core tables, found ${count:-0}."
    exit 1
  fi
}

echo "NovaPay API test started"

if ! curl -sS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "Server is not reachable at $BASE_URL"
  echo "Start server first, then run npm run api:test"
  exit 1
fi

# Health checks
call_api "GET" "/health" "__NO_BODY__"
assert_status "200" "GET /health"

call_api "GET" "/health/db" "__NO_BODY__"
assert_status "200" "GET /health/db"

call_api "POST" "/accounts/wallets" "{}"
if [ "$RESPONSE_STATUS" = "404" ] && printf "%s" "$RESPONSE_BODY" | grep -q "Cannot POST /accounts/wallets"; then
  echo "Detected stale server process without latest routes mounted."
  echo "Restart the app server and run: npm run api:test"
  exit 1
fi

if ! run_sql "SELECT 1;" >/dev/null 2>&1; then
  echo "Cannot access database via docker compose. Ensure postgres is up: docker compose -f $COMPOSE_FILE up -d postgres"
  exit 1
fi

ensure_schema

# Account service validations
call_api "POST" "/accounts/wallets" '{"userId":"bad-id","currency":"usd","initialBalanceMinor":1000}'
assert_status "400" "POST /accounts/wallets invalid userId"

USER_A=$(uuid)
USER_B=$(uuid)

call_api "POST" "/accounts/wallets" "{\"userId\":\"$USER_A\",\"currency\":\"USD\",\"initialBalanceMinor\":100000}"
assert_status "201" "POST /accounts/wallets create sender wallet"
SENDER_WALLET_ID=$(json_get "$RESPONSE_BODY" "data.walletId" 2>/dev/null || true)

call_api "POST" "/accounts/wallets" "{\"userId\":\"$USER_A\",\"currency\":\"USD\",\"initialBalanceMinor\":1000}"
assert_status "409" "POST /accounts/wallets duplicate wallet"

call_api "POST" "/accounts/wallets" "{\"userId\":\"$USER_B\",\"currency\":\"USD\",\"initialBalanceMinor\":10000}"
assert_status "201" "POST /accounts/wallets create receiver wallet"
RECEIVER_WALLET_ID=$(json_get "$RESPONSE_BODY" "data.walletId" 2>/dev/null || true)

call_api "GET" "/accounts/wallets/$SENDER_WALLET_ID" "__NO_BODY__"
assert_status "200" "GET /accounts/wallets/:walletId"

call_api "GET" "/accounts/users/$USER_A/wallets" "__NO_BODY__"
assert_status "200" "GET /accounts/users/:userId/wallets"

# FX service
call_api "POST" "/fx/quote" '{"sourceCurrency":"USD","targetCurrency":"USD"}'
assert_status "201" "POST /fx/quote issue quote"
FX_QUOTE_1=$(json_get "$RESPONSE_BODY" "data.quoteId" 2>/dev/null || true)

call_api "GET" "/fx/quote/$FX_QUOTE_1" "__NO_BODY__"
assert_status "200" "GET /fx/quote/:id"

# Transaction validation
call_api "POST" "/transactions/transfers" '{"senderWalletId":"bad","receiverWalletId":"bad","amountMinor":1,"currency":"USD"}'
assert_status "400" "POST /transactions/transfers missing idempotency key"

# Scenario A: same key twice, second replay, no double debit
BAL_SENDER_BEFORE=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$SENDER_WALLET_ID';" | tr -d '[:space:]')
BAL_RECEIVER_BEFORE=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$RECEIVER_WALLET_ID';" | tr -d '[:space:]')

KEY_A="key-a-$(uuid)"
AMOUNT_A=2500
PAYLOAD_A="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":$AMOUNT_A,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_1\"}"

call_api "POST" "/transactions/transfers" "$PAYLOAD_A" -H "idempotency-key: $KEY_A"
assert_status "201" "Scenario A first request"
TRANSFER_A=$(json_get "$RESPONSE_BODY" "data.transferId" 2>/dev/null || true)

call_api "POST" "/transactions/transfers" "$PAYLOAD_A" -H "idempotency-key: $KEY_A"
assert_status "200" "Scenario A second duplicate request replay"

BAL_SENDER_AFTER_A=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$SENDER_WALLET_ID';" | tr -d '[:space:]')
BAL_RECEIVER_AFTER_A=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$RECEIVER_WALLET_ID';" | tr -d '[:space:]')

EXPECTED_SENDER_AFTER_A=$((BAL_SENDER_BEFORE - AMOUNT_A))
EXPECTED_RECEIVER_AFTER_A=$((BAL_RECEIVER_BEFORE + AMOUNT_A))

assert_int_eq "$EXPECTED_SENDER_AFTER_A" "$BAL_SENDER_AFTER_A" "Scenario A sender debited once"
assert_int_eq "$EXPECTED_RECEIVER_AFTER_A" "$BAL_RECEIVER_AFTER_A" "Scenario A receiver credited once"

# Scenario E: same key different payload
PAYLOAD_E="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":2600,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_1\"}"
call_api "POST" "/transactions/transfers" "$PAYLOAD_E" -H "idempotency-key: $KEY_A"
assert_status "409" "Scenario E same key different payload"
assert_body_contains "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" "Scenario E mismatch error code"

# Scenario B: 3 concurrent identical requests in race
call_api "POST" "/fx/quote" '{"sourceCurrency":"USD","targetCurrency":"USD"}'
assert_status "201" "Scenario B quote created"
FX_QUOTE_B=$(json_get "$RESPONSE_BODY" "data.quoteId" 2>/dev/null || true)

BAL_SENDER_BEFORE_B=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$SENDER_WALLET_ID';" | tr -d '[:space:]')
BAL_RECEIVER_BEFORE_B=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$RECEIVER_WALLET_ID';" | tr -d '[:space:]')

KEY_B="key-b-$(uuid)"
AMOUNT_B=3000
PAYLOAD_B="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":$AMOUNT_B,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_B\"}"

for i in 1 2 3; do
  (
    curl -sS -o "/tmp/novapay_race_body_$i.json" -w "%{http_code}" -X POST "$BASE_URL/transactions/transfers" \
      -H "Content-Type: application/json" \
      -H "idempotency-key: $KEY_B" \
      -d "$PAYLOAD_B" > "/tmp/novapay_race_status_$i.txt"
  ) &
done
wait

S201=0
S200=0
for i in 1 2 3; do
  code=$(cat "/tmp/novapay_race_status_$i.txt")
  [ "$code" = "201" ] && S201=$((S201 + 1))
  [ "$code" = "200" ] && S200=$((S200 + 1))
  rm -f "/tmp/novapay_race_status_$i.txt" "/tmp/novapay_race_body_$i.json"
done

if [ "$S201" -eq 1 ] && [ "$S200" -eq 2 ]; then
  log_pass "Scenario B race expected statuses (1x201,2x200)"
else
  log_fail "Scenario B race status distribution" "got ${S201}x201 and ${S200}x200"
fi

BAL_SENDER_AFTER_B=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$SENDER_WALLET_ID';" | tr -d '[:space:]')
BAL_RECEIVER_AFTER_B=$(run_sql "SELECT balance_minor FROM wallets WHERE wallet_id='$RECEIVER_WALLET_ID';" | tr -d '[:space:]')
EXPECTED_SENDER_AFTER_B=$((BAL_SENDER_BEFORE_B - AMOUNT_B))
EXPECTED_RECEIVER_AFTER_B=$((BAL_RECEIVER_BEFORE_B + AMOUNT_B))

assert_int_eq "$EXPECTED_SENDER_AFTER_B" "$BAL_SENDER_AFTER_B" "Scenario B sender debited once"
assert_int_eq "$EXPECTED_RECEIVER_AFTER_B" "$BAL_RECEIVER_AFTER_B" "Scenario B receiver credited once"

# FX single-use quote
call_api "POST" "/fx/quote" '{"sourceCurrency":"USD","targetCurrency":"USD"}'
assert_status "201" "FX single-use quote created"
FX_QUOTE_USED=$(json_get "$RESPONSE_BODY" "data.quoteId" 2>/dev/null || true)

KEY_FX1="key-fx-1-$(uuid)"
PAYLOAD_FX1="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":1000,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_USED\"}"
call_api "POST" "/transactions/transfers" "$PAYLOAD_FX1" -H "idempotency-key: $KEY_FX1"
assert_status "201" "FX quote used in first transfer"

KEY_FX2="key-fx-2-$(uuid)"
PAYLOAD_FX2="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":1000,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_USED\"}"
call_api "POST" "/transactions/transfers" "$PAYLOAD_FX2" -H "idempotency-key: $KEY_FX2"
assert_status "409" "FX quote cannot be reused"
assert_body_contains "QUOTE_ALREADY_USED_OR_EXPIRED" "FX single-use error"

# FX expired quote
call_api "POST" "/fx/quote" '{"sourceCurrency":"USD","targetCurrency":"USD"}'
assert_status "201" "FX expired scenario quote created"
FX_QUOTE_EXPIRE=$(json_get "$RESPONSE_BODY" "data.quoteId" 2>/dev/null || true)

if run_sql "SELECT 1;" >/dev/null 2>&1; then
  run_sql "UPDATE fx_quotes SET status='ACTIVE', expires_at=NOW() - INTERVAL '1 second', used_at=NULL WHERE quote_id='$FX_QUOTE_EXPIRE';" >/dev/null
  KEY_EXPIRED="key-fx-expired-$(uuid)"
  PAYLOAD_EXPIRED="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":500,\"currency\":\"USD\",\"fxQuoteId\":\"$FX_QUOTE_EXPIRE\"}"
  call_api "POST" "/transactions/transfers" "$PAYLOAD_EXPIRED" -H "idempotency-key: $KEY_EXPIRED"
  assert_status "409" "FX expired quote is rejected"
  assert_body_contains "QUOTE_EXPIRED" "FX expired error code"
else
  log_skip "FX expired quote test" "database shell access unavailable"
fi

# Scenario D: idempotency expiry after 24h
KEY_D="key-d-$(uuid)"
PAYLOAD_D="{\"senderWalletId\":\"$SENDER_WALLET_ID\",\"receiverWalletId\":\"$RECEIVER_WALLET_ID\",\"amountMinor\":700,\"currency\":\"USD\"}"
call_api "POST" "/transactions/transfers" "$PAYLOAD_D" -H "idempotency-key: $KEY_D"
assert_status "201" "Scenario D baseline transfer"

if run_sql "SELECT 1;" >/dev/null 2>&1; then
  run_sql "UPDATE idempotency_keys SET expires_at=NOW() - INTERVAL '1 hour' WHERE idempotency_key='$KEY_D';" >/dev/null
  call_api "POST" "/transactions/transfers" "$PAYLOAD_D" -H "idempotency-key: $KEY_D"
  if [ "$RESPONSE_STATUS" = "409" ]; then
    log_pass "Scenario D expired idempotency key rejected"
  else
    log_fail "Scenario D expired idempotency key rejected" "expected 409, got $RESPONSE_STATUS, body=$RESPONSE_BODY"
  fi
else
  log_skip "Scenario D idempotency expiry" "database shell access unavailable"
fi

# Scenario C: atomicity guard check via ledger invariant query
if run_sql "SELECT 1;" >/dev/null 2>&1; then
  BROKEN_COUNT=$(run_sql "SELECT COUNT(*) FROM (SELECT transfer_id, SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE 0 END) AS debit_total, SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE 0 END) AS credit_total, COUNT(*) AS entry_count FROM ledger_entries GROUP BY transfer_id) t WHERE t.debit_total <> t.credit_total OR t.entry_count <> 2;" | tr -d '[:space:]')
  assert_int_eq 0 "${BROKEN_COUNT:-0}" "Scenario C no partial/unbalanced ledger entries"
else
  log_skip "Scenario C ledger atomicity query" "database shell access unavailable"
fi

# Transaction read APIs
if [ -n "${TRANSFER_A:-}" ]; then
  call_api "GET" "/transactions/transfers/$TRANSFER_A" "__NO_BODY__"
  assert_status "200" "GET /transactions/transfers/:transferId"
fi

call_api "GET" "/transactions/wallets/$SENDER_WALLET_ID/transfers?limit=2" "__NO_BODY__"
assert_status "200" "GET /transactions/wallets/:walletId/transfers"

call_api "GET" "/transactions/wallets/$SENDER_WALLET_ID/transfers?limit=200" "__NO_BODY__"
assert_status "400" "GET /transactions/wallets/:walletId/transfers invalid limit"

# Ledger route validation
call_api "POST" "/ledger/transfers" '{"senderWalletId":"x"}'
assert_status "400" "POST /ledger/transfers validation"

# FX provider down scenario (depends on server env)
call_api "POST" "/fx/quote" '{"sourceCurrency":"USD","targetCurrency":"EUR"}'
if [ "$RESPONSE_STATUS" = "503" ]; then
  log_pass "FX provider down returns clear error"
else
  log_skip "FX provider down scenario" "set FX_PROVIDER_UP=false before starting server to validate this case"
fi

echo
echo "Summary: pass=$PASS_COUNT fail=$FAIL_COUNT skip=$SKIP_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
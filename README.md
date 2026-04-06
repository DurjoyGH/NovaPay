# NovaPay

This README document describes project features, setup instructions and some insights.

## 1. Setup Instructions and Run Steps

This project is intended to be self-contained with Docker.

Prerequisites:
- Docker + Docker Compose

Build and start everything from Docker:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Open the system:
- API base: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`
	- Username: `admin`
	- Password: `admin`
- Jaeger: `http://localhost:16686`

Stop containers:

```bash
docker compose -f infra/docker-compose.yml down
```

## 2. API Endpoint Summary (With One Example Per Endpoint)

Response envelope pattern:
- Success: `{ ok: true, data: ..., requestId }`
- Error: `{ ok: false, error, timestamp }`

### 2.1 Health and Metrics

Endpoint: `GET /health`

Request:
```http
GET /health
```

Response example:
```json
{
	"ok": true,
	"service": "novapay",
	"timestamp": "2026-04-06T12:00:00.000Z"
}
```

Endpoint: `GET /health/db`

Request:
```http
GET /health/db
```

Response example:
```json
{
	"ok": true,
	"database": "connected",
	"timestamp": "2026-04-06T12:00:00.000Z"
}
```

Endpoint: `GET /metrics`

Request:
```http
GET /metrics
```

Response example:
```text
# HELP novapay_http_request_duration_seconds HTTP request duration in seconds
# TYPE novapay_http_request_duration_seconds histogram
novapay_http_request_duration_seconds_bucket{...} 10
```

### 2.2 Account Service

Endpoint: `POST /accounts/wallets`

Request:
```http
POST /accounts/wallets
Content-Type: application/json

{
	"userId": "11111111-1111-1111-1111-111111111111",
	"currency": "USD",
	"initialBalanceMinor": 100000
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"walletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"userId": "11111111-1111-1111-1111-111111111111",
		"currency": "USD",
		"balanceMinor": 100000,
		"createdAt": "2026-04-06T12:00:00.000Z",
		"updatedAt": "2026-04-06T12:00:00.000Z"
	},
	"requestId": "req-1"
}
```

Endpoint: `GET /accounts/wallets/:walletId`

Request:
```http
GET /accounts/wallets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
```

Response example:
```json
{
	"ok": true,
	"data": {
		"walletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"userId": "11111111-1111-1111-1111-111111111111",
		"currency": "USD",
		"balanceMinor": 100000,
		"createdAt": "2026-04-06T12:00:00.000Z",
		"updatedAt": "2026-04-06T12:00:00.000Z"
	},
	"requestId": "req-2"
}
```

Endpoint: `GET /accounts/users/:userId/wallets`

Request:
```http
GET /accounts/users/11111111-1111-1111-1111-111111111111/wallets
```

Response example:
```json
{
	"ok": true,
	"data": [
		{
			"walletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			"userId": "11111111-1111-1111-1111-111111111111",
			"currency": "USD",
			"balanceMinor": 100000,
			"createdAt": "2026-04-06T12:00:00.000Z",
			"updatedAt": "2026-04-06T12:00:00.000Z"
		}
	],
	"requestId": "req-3"
}
```

### 2.3 FX Service

Endpoint: `POST /fx/quote`

Request:
```http
POST /fx/quote
Content-Type: application/json

{
	"sourceCurrency": "USD",
	"targetCurrency": "EUR"
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"quoteId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		"sourceCurrency": "USD",
		"targetCurrency": "EUR",
		"rate": 0.92,
		"status": "ACTIVE",
		"expiresAt": "2026-04-06T12:01:00.000Z"
	},
	"requestId": "req-4"
}
```

Endpoint: `GET /fx/quote/:quoteId`

Request:
```http
GET /fx/quote/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
```

Response example:
```json
{
	"ok": true,
	"data": {
		"quoteId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		"status": "ACTIVE",
		"remainingTtlSeconds": 42
	},
	"requestId": "req-5"
}
```

### 2.4 Transaction Service

Endpoint: `POST /transactions/transfers`

Request:
```http
POST /transactions/transfers
idempotency-key: key-123
Content-Type: application/json

{
	"senderWalletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	"receiverWalletId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
	"amountMinor": 2500,
	"currency": "USD"
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"transferId": "dddddddd-dddd-dddd-dddd-dddddddddddd",
		"idempotencyKey": "key-123",
		"senderWalletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"receiverWalletId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
		"amountMinor": 2500,
		"currency": "USD",
		"status": "COMPLETED",
		"fxQuoteId": null,
		"fxRateLocked": null,
		"idempotentReplay": false
	},
	"requestId": "req-6"
}
```

Endpoint: `GET /transactions/transfers/:transferId`

Request:
```http
GET /transactions/transfers/dddddddd-dddd-dddd-dddd-dddddddddddd
```

Response example:
```json
{
	"ok": true,
	"data": {
		"transferId": "dddddddd-dddd-dddd-dddd-dddddddddddd",
		"status": "COMPLETED",
		"ledgerEntries": [
			{
				"direction": "DEBIT",
				"amountMinor": 2500,
				"currency": "USD"
			},
			{
				"direction": "CREDIT",
				"amountMinor": 2500,
				"currency": "USD"
			}
		]
	},
	"requestId": "req-7"
}
```

Endpoint: `GET /transactions/wallets/:walletId/transfers?limit=50`

Request:
```http
GET /transactions/wallets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/transfers?limit=2
```

Response example:
```json
{
	"ok": true,
	"data": [
		{
			"transferId": "dddddddd-dddd-dddd-dddd-dddddddddddd",
			"amountMinor": 2500,
			"status": "COMPLETED"
		}
	],
	"requestId": "req-8"
}
```

### 2.5 International Transfer Alias

Endpoint: `POST /transfers/international`

Request:
```http
POST /transfers/international
idempotency-key: key-intl-1
Content-Type: application/json

{
	"senderWalletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	"receiverWalletId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
	"amountMinor": 200000,
	"currency": "USD",
	"fxQuoteId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"transferId": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
		"status": "COMPLETED",
		"fxQuoteId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
		"fxRateLocked": 0.92
	},
	"requestId": "req-9"
}
```

### 2.6 Ledger Service Direct Endpoint

Endpoint: `POST /ledger/transfers`

Request:
```http
POST /ledger/transfers
Content-Type: application/json

{
	"idempotencyKey": "key-ledger-1",
	"senderWalletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	"receiverWalletId": "cccccccc-cccc-cccc-cccc-cccccccccccc",
	"amountMinor": 1000,
	"currency": "USD"
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"transferId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
		"status": "COMPLETED"
	},
	"requestId": "req-10"
}
```

### 2.7 Payroll Service

Endpoint: `POST /payroll/batches`

Request:
```http
POST /payroll/batches
Content-Type: application/json

{
	"employerAccountId": "12121212-1212-1212-1212-121212121212",
	"sourceWalletId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
	"currency": "USD",
	"items": [
		{
			"employeeWalletId": "13131313-1313-1313-1313-131313131313",
			"amountMinor": 1200
		},
		{
			"employeeWalletId": "14141414-1414-1414-1414-141414141414",
			"amountMinor": 900
		}
	]
}
```

Response example:
```json
{
	"ok": true,
	"data": {
		"batchId": "15151515-1515-1515-1515-151515151515",
		"employerAccountId": "12121212-1212-1212-1212-121212121212",
		"status": "QUEUED",
		"totalJobs": 2,
		"completedJobs": 0,
		"failedJobs": 0
	},
	"requestId": "req-11"
}
```

Endpoint: `GET /payroll/batches/:batchId`

Request:
```http
GET /payroll/batches/15151515-1515-1515-1515-151515151515
```

Response example:
```json
{
	"ok": true,
	"data": {
		"batchId": "15151515-1515-1515-1515-151515151515",
		"status": "COMPLETED",
		"totalJobs": 2,
		"completedJobs": 2,
		"failedJobs": 0,
		"errors": []
	},
	"requestId": "req-12"
}
```

## 3. All Five Idempotency Scenarios (Exact Handling)

Scenario A: same key arrives twice
- First request inserts idempotency key and processes transfer.
- Second request finds existing transfer for same key and returns replay (`200`) with no extra debit.

Scenario B: three identical requests within 100ms
- Only one request wins insert+lock path.
- Losing requests hit existing transfer path after lock/commit and return replay.
- DB mechanism used: unique idempotency key + `ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE`.

Scenario C: server crashes after debit before credit
- Debit and credit are in one DB transaction.
- If crash happens before commit, PostgreSQL rollback removes partial state.
- On recovery, no committed half-transfer remains.

Scenario D: key expires after 24h, retried at 30h
- Request is rejected with `IDEMPOTENCY_KEY_EXPIRED` (`409`).
- Client must send a new idempotency key.

Scenario E: same key reused with different payload amount
- Request payload hash is compared with stored hash.
- Mismatch returns `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` (`409`).

## 4. Double-Entry Invariant and How It Is Verified

Invariant used in this project:
- Every transfer must produce exactly two ledger entries.
- Exactly one `DEBIT` and one `CREDIT`.
- For same-currency transfer, debit amount must equal credit amount in same currency.
- For FX transfer, amount equality is not forced because conversion rate applies.

How verification is done:
- Runtime check inside transfer transaction validates counts and amounts before commit.
- If invariant fails, transfer is rolled back and `LEDGER_INVARIANT_VIOLATION` is raised.
- Metrics counter is incremented for violation alerting.
- Integration script also runs SQL invariant checks.

## 5. FX Quote Strategy

What is implemented:
- `POST /fx/quote` issues quote with 60-second TTL.
- `GET /fx/quote/:id` returns quote validity.
- Quote is single-use: status must be `ACTIVE` and becomes `USED` during transfer.
- Expired quote is rejected with `QUOTE_EXPIRED`.
- Reused or invalid-status quote is rejected with `QUOTE_ALREADY_USED_OR_EXPIRED`.
- If provider is unavailable, API returns `FX_PROVIDER_UNAVAILABLE` (`503`).
- Locked FX rate is stored on transfer and ledger entries.

## 6. Payroll Resumability Mechanism and Checkpoint Pattern

Pattern currently used:
- Batch-level progress checkpoint fields are kept in memory:
	- `status` (`QUEUED`, `PROCESSING`, `COMPLETED`, `PARTIAL_FAILED`)
	- `totalJobs`, `completedJobs`, `failedJobs`, `errors`
- Worker lifecycle events update these checkpoints:
	- `active` -> `PROCESSING`
	- `completed` -> increment completed counter
	- `failed` -> increment failed counter and append error
- Terminal condition checkpoint:
	- when `completedJobs + failedJobs == totalJobs`

Resumability behavior in practice:
- Individual payroll job retries are handled by BullMQ (`attempts: 5`, exponential backoff).
- Transfer-level idempotency keys prevent duplicate money movement per job.

Important limitation:
- Batch checkpoint state is currently in-memory map, not persisted in database.
- After app restart, batch progress history is not fully recoverable.

## 7. Audit Hash Chain and Tamper Detection

Current implementation status:
- Audit hash chain is not implemented in this codebase yet.

What tampered record detection means in practice:
- In a hash-chain audit log, each record stores a hash of its own payload plus previous record hash.
- If someone changes an old record, all downstream hashes break.
- Verification process recomputes chain and flags first broken link as tampered.

What is available today instead:
- Strong transactional integrity for transfers and ledger entries.
- Structured logs and traces for operational investigation.

## 8. Tradeoffs Made Under Time Pressure

Tradeoffs taken:
- Chose integration shell tests first instead of full unit test suite.
- Kept service code in one process rather than full distributed deployment.
- Used one PostgreSQL database instead of separate database per service.
- Implemented payroll checkpoint tracking in memory for faster delivery.
- Prioritized correctness flows (idempotency, atomic transfer, FX lock) over feature completeness (admin panel, encryption).

## 9. What I Would Add Before Production

Before production, I would add:
- Field-level envelope encryption (DEK/KEK) for sensitive data.
- Persistent payroll checkpoint storage and restart-safe recovery.
- Full unit and integration test coverage in CI.
- Restore CI/CD workflow with changed-service detection + version bump enforcement.
- Service-level DB isolation and API gateway policy hardening.
- Outbox/event-driven reconciliation pipeline.
- Audit hash chain table + scheduled chain verification job.
- Secret management and key rotation policy.

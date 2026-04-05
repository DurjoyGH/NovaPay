# NovaPay - Checkpoint 2 Decisions

Date: 2026-04-06

## 1. Scope Status

Current implementation status is partial for Checkpoint 2.

Implemented:
- Account Service endpoints and validation.
- Ledger Service atomic transfer posting with double-entry records.
- Transaction Service orchestration and history reads.
- FX quote issue/validate and transaction integration.
- End-to-end curl regression script (`npm run api:test`) with core scenario coverage.

Not yet implemented:
- Payroll Service (bulk payroll ingestion + queue workers).
- Admin Service endpoints.
- Unit tests per service (current test harness is integration curl script, not unit tests).
- Field-level envelope encryption for sensitive data.
- Fully self-contained Docker Compose for all services (currently PostgreSQL only).
- Dedicated `POST /transfers/international` endpoint path (current flow supports FX via `POST /transactions/transfers` + `fxQuoteId`).

Conclusion: APIs are not yet 100% matched to the full Checkpoint 2 requirements.

## 2. Core Financial Correctness Decisions

### 2.1 Double-entry Ledger is mandatory

Every transfer writes exactly two ledger rows in one DB transaction:
- DEBIT sender wallet
- CREDIT receiver wallet

Invariant:
- Sum(DEBIT) == Sum(CREDIT) for each transfer.

If invariant check fails, the DB transaction is rolled back.

### 2.2 Idempotency model

Design:
- `idempotency_keys.idempotency_key` is unique.
- Request payload hash is stored as `request_hash`.
- Key TTL is 24 hours (`expires_at`).
- Conflict-safe insert uses `ON CONFLICT DO NOTHING` to avoid transaction-abort side effects.

Outcomes:
- Same key + same payload returns replay response.
- Same key + different payload returns `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` (409).
- Expired key returns `IDEMPOTENCY_KEY_EXPIRED` (409).

### 2.3 Atomic commit strategy

All critical money movement operations execute in one PostgreSQL transaction:
- Validate/lock source and destination wallets (`FOR UPDATE`).
- Validate/consume FX quote (if present).
- Insert transfer row.
- Insert debit + credit ledger rows.
- Update both wallet balances.
- Mark transfer complete.
- Persist idempotency response.

If any step fails, rollback ensures no partial transfer persists.

## 3. Problem 1 Scenarios (A-E)

### Scenario A: Same key arrives twice

Decision:
- First request processes and commits transfer.
- Second request reads existing transfer by idempotency key and returns replay.

Result:
- No second debit.

### Scenario B: Three identical requests within 100ms

Decision:
- All requests share one idempotency key.
- Only one request creates the transfer.
- Two losing requests observe existing committed transfer and return replay.

Database-level behavior:
- `idempotency_keys` uniqueness + transactional read path ensure one winner.
- Losing requests do not post additional ledger rows.

Expected API statuses:
- One `201` (winner)
- Two `200` (replays)

### Scenario C: Crash after debit before credit

Decision:
- Debit and credit are in the same DB transaction.

Result:
- If process crashes before commit, PostgreSQL rolls back both.
- On recovery, there is no partial committed state requiring reconciliation for that transaction.

### Scenario D: Key expires after 24h, retried at 30h

Decision:
- If `expires_at <= now`, reject as `IDEMPOTENCY_KEY_EXPIRED` (409).
- Client must issue a new key to re-initiate.

### Scenario E: Same key used with different amount

Decision:
- Compare stored `request_hash` with current hash.
- Mismatch is rejected as `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` (409).

## 4. Problem 2: Bulk Payroll Queue Decision

Implemented design:
- BullMQ queue partitioned by employer account (`payroll:<employerAccountId>`).
- Exactly one BullMQ worker per employer queue with `concurrency: 1`.
- Batch ingestion endpoint enqueues one credit job per employee in that employer queue.

Why this is better than DB lock-heavy strategies for 14,000 credits from one source account:
- Deterministic serialization for one employer eliminates same-source race conditions by design, not by lock timing luck.
- Removes large lock wait queues on the source wallet row and lowers deadlock/retry storms under burst traffic.
- Keeps high system throughput because other employers use separate queues and workers and can progress in parallel.
- Retries are scoped to failed jobs only, so one bad credit does not force replay of the full 14,000-item batch.
- Queue backpressure is explicit and observable (queued, active, failed counts), unlike opaque DB lock contention.

## 5. Problem 3: FX Locking Decisions

Implemented decisions:
- `POST /fx/quote` creates a quote with 60s TTL.
- `GET /fx/quote/:id` returns validity and remaining time.
- Quote is single-use (`ACTIVE` -> `USED`) during transfer commit.
- Expired quote is rejected with `QUOTE_EXPIRED`.
- Reused quote is rejected with `QUOTE_ALREADY_USED_OR_EXPIRED`.
- FX provider down returns clear `FX_PROVIDER_UNAVAILABLE` error (503).

Persisted fields:
- `transfers.fx_quote_id`, `transfers.fx_rate_locked`
- `ledger_entries.fx_quote_id`, `ledger_entries.fx_rate_locked`

Gap to close for exact API contract match:
- Add dedicated `POST /transfers/international` endpoint (currently handled by `POST /transactions/transfers` using `fxQuoteId`).

## 6. Problem 4: Field-level Encryption

Status: not implemented yet.

Required decision (pending implementation):
- Envelope encryption with two-key hierarchy.
	- DEK encrypts sensitive fields per record.
	- KEK encrypts DEK.
- Never store plaintext sensitive values in DB.
- Never log plaintext secrets or sensitive PII.

## 7. Verification Status

Current integration suite (`npm run api:test`) validates:
- Idempotency scenario A/B/E.
- Atomicity invariant checks.
- Expired idempotency behavior (D).
- FX quote issue/validate/single-use/expiry.
- Account, transaction, and ledger endpoint validation.

Current caveat:
- FX provider-down path remains skipped unless server is started with `FX_PROVIDER_UP=false`.

## 8. Next Actions to Complete Checkpoint 2 Fully

1. Implement Payroll Service + BullMQ worker model with per-employer serialization.
2. Implement Admin Service endpoints.
3. Add unit tests for each service module and route layer.
4. Implement field-level envelope encryption utilities and integrate with data writes/reads.
5. Expand Docker Compose to run all app services + dependencies (Redis for BullMQ).
6. Add `POST /transfers/international` endpoint alias with same FX validations.

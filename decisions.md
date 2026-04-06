# NovaPay Decisions

Date: 2026-04-06

This file is a simple summary of what is done and what is not done yet.

## Checkpoint 1: Architecture and Design

What I did:
- I built one API app with these service modules:
	- account-service
	- transaction-service
	- ledger-service
	- fx-service
	- payroll-service
- I kept clear route boundaries in code:
	- /accounts
	- /transactions
	- /transfers/international
	- /ledger
	- /fx
	- /payroll
- I use queue-based payroll processing with BullMQ and one worker concurrency per employer queue.

What I could not fully complete:
- I did not build a full true microservice deployment with separate service processes.
- I did not implement Admin Service endpoints (admin-service folder is not present now).
- I did not create separate databases per service. Current design uses one shared PostgreSQL database.
- I did not provide a dedicated architecture diagram file in the repo.
- I did not provide full per-service data-model docs in a dedicated schema document.

## Checkpoint 2: Core Implementation

What I did:
- Account Service basic wallet creation and reads are working.
- Transaction Service creates transfers and supports idempotency key handling.
- Ledger Service writes debit/credit entries in one DB transaction.
- FX Service issues 60-second quotes, validates TTL, and enforces single use.
- Payroll Service accepts batch jobs and processes them via BullMQ queue.
- Added alias endpoint:
	- POST /transfers/international
- Added integration test script:
	- npm run api:test

Problem 1 (Idempotency) current status:
- Scenario A: done
- Scenario B: done
- Scenario C: done with atomic DB transaction rollback model
- Scenario D: done
- Scenario E: done

Problem 2 (Bulk Payroll) current status:
- Done with BullMQ, queue partition by employer, worker concurrency 1.

Problem 3 (FX Locking) current status:
- POST /fx/quote: done
- GET /fx/quote/:id: done
- POST /transfers/international with quote validation: done
- Expiry + single-use + provider-down error handling: done

Problem 4 (Field-Level Encryption) current status:
- Not done.

What I could not fully complete:
- Unit tests per service are not done yet.
- Tests are currently integration-style script tests, not full unit test suites.

## Checkpoint 3: Observability and Monitoring

What I did:
- Added metrics endpoint and Prometheus metrics.
- Added structured logging with requestId, userId, transactionId, timestamp.
- Added tracing setup to Jaeger using OpenTelemetry.
- Added Prometheus, Grafana, Jaeger in Docker Compose.
- Added alert rule for ledger invariant violation > 0.

What I could not fully complete:
- I did not produce a permanent documented trace screenshot/report in repo files.
- FX-down trace demo exists in scripts history/workflow, but formal evidence file is not stored.

## Checkpoint 4: CI/CD

Current status:
- Not done

## Final Summary

Main things done:
- Core APIs are implemented for account, transaction, ledger, FX, and payroll.
- Idempotency and FX quote locking flows are implemented.
- International transfer alias endpoint is implemented.
- Integration test script covers major scenarios.
- Observability stack is integrated in compose.

Main things not done:
- Field-level encryption.
- Full unit test coverage per service.
- Admin Service.
- True microservice isolation with separate database per service.
- CI/CD workflow.

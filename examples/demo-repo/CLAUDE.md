# CLAUDE.md — quickcontract-api

Project guidance for Claude Code sessions in this repository.

## What this service does

Contract lifecycle + escrow for a freelance marketplace. Clients fund an
escrow account per contract; the payment provider's `payment.captured`
webhook triggers the release of funds to the freelancer.

## Working agreements

- Package manager is **pnpm** (`pnpm test`, `pnpm lint`, `pnpm typecheck`).
- Keep services small and focused; one domain concept per directory under
  `src/`.
- Prisma is the only persistence layer. Update `prisma/schema.prisma` and add
  a migration for any model change — never edit generated client code.
- Prefer guard clauses and idempotency checks over defensive try/catch.

## Known sharp edges

- The payment provider **retries webhooks** with the same event id until it
  gets a 2xx. Any handler in `src/escrow/` must be idempotent.
- `releasedAmountCents` must never exceed `amountCents` on an escrow account.

## Review checklist for money paths

1. Is the operation idempotent under retry?
2. Is there a unique constraint or status guard backing the idempotency?
3. Are amounts integer cents end to end?

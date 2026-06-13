# Agent instructions — quickcontract-api

Instructions for AI coding agents working in this repository.

## Commands

- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`

Run `pnpm typecheck` and `pnpm test` before declaring any change done.

## Conventions

- NestJS module-per-domain layout: `src/<domain>/<domain>.service.ts`.
- All database access goes through `PrismaService`; never instantiate a raw
  `PrismaClient` in feature code.
- Money is always integer cents (`amountCents`); currency is an ISO 4217 code.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`) from
  services; controllers must not contain business logic.

## Safety rules

- `src/escrow/` and the Prisma schema are payment-critical: propose changes as
  patches and wait for human review, do not auto-apply.
- Never commit secrets. `.env*` files are local-only; `.env.example` carries
  variable names with placeholder values.
- Database schema changes require a Prisma migration in `prisma/migrations/`.

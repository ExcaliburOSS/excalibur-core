# QuickContract API

QuickContract is the backend for a freelance-marketplace contract platform:
clients and freelancers sign fixed-price contracts, the client funds an escrow
account, and funds are released to the freelancer when the payment provider
confirms capture.

> This repository is a **demo fixture** for Excalibur. Dependencies are never
> installed; the code exists so Excalibur's repository analysis and mock
> workflows have something realistic to look at.

## Stack

- Node.js 20, TypeScript
- NestJS 10 (REST API)
- Prisma 5 + PostgreSQL
- Jest for tests

## Project layout

```text
src/
  main.ts                      # Nest bootstrap
  app.module.ts
  prisma.service.ts
  contracts/contracts.service.ts   # contract lifecycle (draft → active → completed)
  escrow/escrow.service.ts         # escrow funding & release, payment webhooks
prisma/
  schema.prisma                # Contract / EscrowAccount / ReleaseTransaction
  migrations/
test/
  escrow.service.spec.ts
```

## Getting started

```bash
pnpm install
cp .env.example .env       # set DATABASE_URL and provider secrets
pnpm prisma:migrate
pnpm start:dev
```

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm test` | run the Jest suite |
| `pnpm lint` | ESLint over `src/` and `test/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build` | compile with the Nest CLI |

## Domain notes

- An escrow account must only ever be released **once**, no matter how many
  times the payment provider retries webhook delivery.
- Money amounts are integer cents; never use floats.

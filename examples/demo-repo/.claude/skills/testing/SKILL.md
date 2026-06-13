---
name: testing
description: Write and run Jest tests for QuickContract services, including Prisma mocking and webhook-retry regression tests.
when-to-use:
  - Adding or changing service logic under src/
  - Fixing a bug that needs a regression test
  - Asked to improve coverage of payment or escrow flows
dependencies:
  - jest
  - ts-jest
  - "@nestjs/testing"
tools:
  - run_tests
  - read_file
  - write_file
---

# Testing skill

How to test QuickContract services correctly.

## Instructions

1. Co-locate unit specs in `test/` as `<name>.spec.ts`, mirroring `src/`.
2. Build services with `Test.createTestingModule` from `@nestjs/testing` and
   provide a mocked `PrismaService` — never connect to a real database in
   unit tests.
3. Mock Prisma model methods per test (`findUnique`, `create`, `update`,
   `findMany`) with `jest.fn()` and assert on call arguments, not just call
   counts.
4. For webhook handlers, always include a retry case: deliver the same event
   twice and assert the side effect happened exactly once.
5. Run the suite with `pnpm test`; a focused file runs with
   `pnpm test -- escrow.service`.

## Conventions

- Test names describe behavior: `releases funds once per captured payment`.
- Use integer cents in fixtures (`amountCents: 250_00`).
- Keep fixtures minimal; build helpers in the spec file, not shared globals.

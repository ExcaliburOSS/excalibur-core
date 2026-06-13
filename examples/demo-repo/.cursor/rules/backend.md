# Backend rules

Rules for Cursor when editing the QuickContract NestJS backend.

- Use the existing `PrismaService` for all database access.
- Services throw `NotFoundException` / `ConflictException`; controllers stay
  thin and never talk to Prisma directly.
- Money values are integer cents. Reject any suggestion that introduces
  floating-point arithmetic on amounts.
- Webhook handlers must be idempotent: check a status or unique provider
  reference before performing side effects.
- New Prisma models or fields require a migration under `prisma/migrations/`.
- Tests live in `test/` and use Jest with `ts-jest`; mock `PrismaService`
  rather than hitting a database.

# RVP Industries — Tamarind Seed Processing Software

Monorepo: `client/` (React + Vite + TS) and `server/` (Express + TS + Prisma). Postgres runs in Docker.

## Pipeline

```
Purchase Order → Stock In → Purchase → Weight Cross-Verification → Payment
      → Processing (out-turn) → Pappu Pricing → Sale Order → Sale Dispatch
```

## Quick start

```bash
# 1. Install all deps (root + client + server)
npm run install:all

# 2. Start Postgres
npm run db:up

# 3. Migrate + seed (after schema is in place)
npm --prefix server run prisma:migrate
npm --prefix server run seed

# 4. Run both dev servers
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:4000 (health: http://localhost:4000/api/health)

## Build order

See `RVP_SOFTWARE_SPEC.md` section 9. Built in stages 0–8.

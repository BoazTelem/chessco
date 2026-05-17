# Chessco

**Scout. Prepare. Win.** — a chess preparation and sparring platform.

- Production: chessco.org (Phase 0, pre-launch)
- Status: Phase 0 — Foundation

---

## What's in here

Three integrated capabilities, built on a single product loop (`Scout → Find → Practice → Pay → Improve`):

1. **Player discovery** — identify a public chess account from partial info using engineered features + learned style embeddings.
2. **Opponent preparation** — per-opponent battle plans showing repertoire, leaks, and exploitable lines vs. your own play.
3. **Paid sparring marketplace** — publish a starting position and pay a fixed fee per game; verified human opponents play it with you, paid for completing the session.

## Documentation

- [docs/PLAN.md](docs/PLAN.md) — 7-phase build plan (week-by-week, with exit criteria)
- [docs/chessco-full-spec.md](docs/chessco-full-spec.md) — full system specification v1.1 (29 sections, source of truth)
- [docs/SETUP.md](docs/SETUP.md) — Vercel + Supabase + observability provisioning checklist
- [docs/fide-ingestion-spec.md](docs/fide-ingestion-spec.md) — FIDE ratings ingestion worker (Phase 0 Week 5)

## Stack

- **Frontend:** Next.js 15 (App Router, TS strict) on Vercel, Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres + Auth + Storage + Realtime + pgvector), Drizzle ORM
- **Game server:** Fly.io (Node WebSocket, server-authoritative clocks)
- **Workers:** Inngest, Stockfish on Cloud Run
- **AI:** DeepSeek (chat-completions; OpenAI-compatible API)
- **Payments:** Stripe Connect Express (MCC 8299 services marketplace)
- **Monorepo:** pnpm workspaces + Turborepo

## Local development

### Requirements

- Node.js 22+
- pnpm 9.15+

### Install & run

    pnpm install
    pnpm dev

Web app at http://localhost:3000.

### Useful commands

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `pnpm dev`          | Start all dev servers in parallel     |
| `pnpm build`        | Production build                      |
| `pnpm typecheck`    | TypeScript checks across all packages |
| `pnpm lint`         | Lint all packages                     |
| `pnpm format`       | Format with Prettier                  |
| `pnpm format:check` | Check formatting without writing      |

## Repository layout

    chessco/
    ├── apps/
    │   └── web/                 # Next.js — marketing + app + admin
    ├── packages/
    │   ├── ui/                  # Brand tokens, design system (shadcn coming)
    │   ├── types/               # Shared TypeScript types
    │   ├── db/                  # Drizzle schema + migrations (Phase 0 Week 2)
    │   ├── chess-core/          # PGN/FEN/engine helpers
    │   ├── ai/                  # Versioned Claude prompts (Phase 1)
    │   └── analytics/           # Event tracking helpers
    ├── docs/                    # PLAN.md, spec
    └── .github/workflows/       # CI

Apps `gameserver/` (Fly.io) and `workers/` (Inngest) come online in later phases.

## Brand

- Primary slate `#0F172A` background (dark mode default)
- Accent amber `#EAB308`
- Typography: Inter (UI) + Geist Sans (display) + Geist Mono (code)
- Tone: direct, professional, no chess clichés ("battle," "warrior," "destroy your enemy" — banned per spec §3 & §17)

## License

Proprietary — all rights reserved.

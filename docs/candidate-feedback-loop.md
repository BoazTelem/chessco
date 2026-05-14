# Candidate Feedback Loop

Chessco result pages ask users to rate each suggested account. This creates a
human feedback loop for calibration, benchmark validation, and future ranking
improvements.

## Feedback Values

Each candidate can receive one of four labels:

- `correct` - 100% right.
- `probably_correct` - not sure, feels right.
- `probably_wrong` - not sure, feels wrong.
- `wrong` - 100% wrong.

The two uncertain labels are intentionally separate from confirmed truth. They
are useful for learning, but they should not make a candidate appear as a
publicly confirmed account.

## Persistence

The current aggregate state lives on `identification_candidates`:

- `user_feedback`
- `user_feedback_by`
- `user_feedback_at`
- legacy `user_confirmed`

Per-user provenance lives in `identification_candidate_feedback` with a unique
row per `(candidate_id, user_id)`.

`user_confirmed` remains for backwards compatibility and for existing profile
surfaces:

- `correct` maps to `user_confirmed = true`.
- `wrong` maps to `user_confirmed = false`.
- `probably_correct`, `probably_wrong`, and cleared feedback map to
  `user_confirmed = null`.

That keeps "Known online accounts" conservative while still collecting softer
signals for ranking.

## API

Endpoint:

```text
POST /api/candidate/{candidate_id}/feedback
```

Body:

```json
{ "feedback": "correct" }
```

Allowed values are `correct`, `probably_correct`, `probably_wrong`, `wrong`, or
`null` to clear the current user's feedback. The legacy body
`{ "confirmed": true | false | null }` is still accepted and normalized.

Authentication is required. Anonymous feedback would be too easy to poison.

## UI

The match page shows four buttons:

- 100% right
- Feels right
- Feels wrong
- 100% wrong

Clicking the active option clears the feedback. The UI updates optimistically and
then refreshes the server-rendered page.

## How To Use The Data

Use feedback for:

- confidence calibration
- comparing benchmark predictions against user judgments
- finding false-positive patterns
- training future ranking/fusion models

Do not use soft feedback as proof of identity. In particular, do not promote
`probably_correct` accounts into public confirmed-account surfaces without a
separate policy decision.

## Related Files

- Migration: `packages/db/migrations/0036_candidate_feedback_strength.sql`
- API: `apps/web/app/api/candidate/[candidate_id]/feedback/route.ts`
- UI: `apps/web/app/scout/match/[query_id]/confirm-buttons.tsx`
- Match page: `apps/web/app/scout/match/[query_id]/page.tsx`
- Benchmark docs: `docs/repertoire-matcher-benchmark.md`

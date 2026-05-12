# Competitors

Internal reference, not marketing. Written for our future selves so we don't have to re-research the landscape every quarter.

---

## TL;DR — our moat

SnoopChess is **name-anchored heuristic lookup** — string-match a name against handles, filter by federation and rating band, return candidates. No AI, no learned representations of play, no feedback loop.

Chessco Scout is **AI stylometric fingerprint matching + signal fusion** — extract a 200–500-feature (Phase 1) or 384-dim transformer-embedded (Phase 2) play fingerprint from one or more confirmed games, then rank candidates by fingerprint similarity, fused with name / country / club / repertoire-description / rating-band signals into a single probabilistic score.

They cannot trivially catch up because:

1. **Corpus debt** — building per-handle feature vectors for millions of players takes 6–12 months of continuous crawling. They'd have to start from zero.
2. **Feedback flywheel** — every `confirm` / `reject` from a real user reweights our ranking globally. Year-over-year accuracy compounds; theirs is frozen at heuristic-rule quality.
3. **Methodology gap** — they'd have to ship Stockfish workers, feature extraction, pgvector HNSW, leave-N-out evaluation, and a transparent benchmark dashboard. Each is weeks of engineering.

---

## SnoopChess (snoopchess.com)

Direct competitor. Same job-to-be-done (find an OTB opponent's online accounts so you can prepare), narrower scope.

### What they do

- **Pitch:** _"Out-Prepare your Chess Opponent!"_
- **Input:** real name + country + FIDE/USCF rating
- **Output:** matched online profiles + opening-repertoire analysis (favorite openings + where the player struggles)
- **Coverage claim:** "billions of games" indexed from Lichess + chess.com
- **Pricing:** "free to try" — no tier breakdown visible
- **Target:** OTB tournament players (FIDE/USCF rated)

### What they don't do

- **No AI pattern matching from sample games.** They don't accept "here's a PGN, find this person." That input mode doesn't exist in their product.
- **No amateur coverage.** Their entry-point is a federation rating; players without one have no path in.
- **No published accuracy.** No benchmark, no methodology page, no per-rating-band hit rate.
- **No feedback loop.** No way for a user to confirm/reject a match and have that improve later searches.
- **No cross-platform consistency boost.** Lichess and chess.com candidates are surfaced independently; no scoring for "same fingerprint appeared on both."
- **No signal fusion.** Filters are conjunctive (name AND country AND rating); no probabilistic ranking that downweights one signal when others are strong.
- **No prep reports / PDF export.**
- **No sparring marketplace.**
- **Minimal public documentation** — `/about` and `/pricing` returned 404 on 2026-05-12.

### Why their approach has a ceiling

Heuristic rules over name strings and rating bands cannot:

- Reason about a 200-dim feature vector
- Fuse stylometric and conventional signals probabilistically
- Distinguish two players with similar names and ratings but different play styles
- Identify a player whose online handle bears no resemblance to their real name (very common for amateurs)
- Improve from user feedback without engineering work

Even if SnoopChess adds AI matching tomorrow, our 8 differentiators below mean they'd still be playing catch-up on multiple axes simultaneously.

### Sources

- Homepage content observed 2026-05-12
- `/about` and `/pricing` returned HTTP 404 on the same date
- Spec [Appendix C](chessco-full-spec.md) has the broader public-facing positioning; this file is the internal teardown

---

## Our differentiators (the must-ship list)

Mirrors `Competitive positioning` in [PLAN.md](PLAN.md) and the Scout plan. Listed by mass — AI matching first because it's the structural moat; the rest support or compound it.

1. **AI stylometric matching from sample game(s)** — paste 1+ confirmed games → top Lichess + chess.com candidates with confidence scores. Stage 3 of the identification pipeline.
2. **Signal fusion** — AI combines fingerprint with name, country, federation, club, rating-band, opening-repertoire description into one ranking, not separate filters.
3. **Amateur coverage** — every chess player, not just FIDE/USCF-rated. Stylometric matching is the ONLY way for unranked players.
4. **Cross-platform consistency boost** — lichess ↔ chess.com fingerprint match between two candidates = strong same-person signal, scored explicitly.
5. **Public, measurable accuracy** at `/trust` — leave-N-out benchmark per rating band, methodology open-sourced on GitHub.
6. **Confirm/reject feedback loop** with global reweighting — every correction trains the next user's search.
7. **LLM evidence prose** per candidate — Claude Haiku justifies each match in plain English (_"matches on Najdorf-as-Black 87%, endgame conversion 94%, time-trouble pattern"_).
8. **12-method lookup catalog** — sample game, handle-to-handle, repertoire description, club, tournament participation, etc.

If a Phase 1 deliverable doesn't push one of these forward, deprioritize it.

---

## What NOT to compete on

- **Raw indexed game count** — SnoopChess's "billions of games" arms race. What matters is feature-vector coverage per handle, not raw row count.
- **OTB-titled-player coverage as a headline** — both platforms have these. Table-stakes, not a moat.
- **Federation browse pages as a moat** — mirror them for SEO and discovery, don't out-spend.
- **Name-string fuzziness alone** — trigram matching on handle strings can be replicated in a weekend. The AI fingerprint cannot.

---

## Adjacent, not direct

These products solve related problems but don't compete for the same query.

- **ChessBase** — desktop preparation tool, $300+, master-level audience. Excellent prep depth, but no online-account identification and no AI matching from sample games. Not a wedge against us; users will use both.
- **Lichess Insights / chess.com Insights** — self-only analytics. You can analyze your own play patterns; you cannot analyze a stranger to find their other accounts. Same engine, different scope.
- **chess-results.com** — events / tournaments directory. Useful as a feeder (Phase 2 W4 cross-table parser) but not a competitor on the identification job.
- **TWIC** — weekly bundle of top-level tournament games. We use it as a target-player game source (Phase 1 W1), not a competing product.

---

## Review cadence

- **Quarterly recheck** of SnoopChess: homepage, `/about`, `/pricing`, any blog/changelog, social.
- **Specifically watch** for any AI/ML announcement on their side. If they ship stylometric matching, our other 7 differentiators (benchmark, feedback loop, signal fusion, etc.) become more important to land quickly.
- **Update this doc** whenever a new feature ships on either side or pricing changes.

Last reviewed: **2026-05-12.**

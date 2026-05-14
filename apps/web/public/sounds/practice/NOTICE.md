# Practice game audio — third-party attribution

The audio samples in this directory are taken verbatim from the **Lichess SFX
sound set** by **Enigmahack**, originally distributed in the
[`lichess-org/lila`](https://github.com/lichess-org/lila) repository under
`public/sound/sfx/`.

| File             | Source                                 |
| ---------------- | -------------------------------------- |
| Move.mp3         | lila/public/sound/sfx/Move.mp3         |
| Capture.mp3      | lila/public/sound/sfx/Capture.mp3      |
| Check.mp3        | lila/public/sound/sfx/Check.mp3        |
| NewChallenge.mp3 | lila/public/sound/sfx/NewChallenge.mp3 |
| LowTime.mp3      | lila/public/sound/sfx/LowTime.mp3      |
| Victory.mp3      | lila/public/sound/sfx/Victory.mp3      |
| Defeat.mp3       | lila/public/sound/sfx/Defeat.mp3       |
| Draw.mp3         | lila/public/sound/sfx/Draw.mp3         |

- **Author:** Enigmahack — https://github.com/Enigmahack
- **License:** GNU Affero General Public License v3 or later (AGPL-3.0-or-later)
- **License source:** https://github.com/lichess-org/lila/blob/master/COPYING.md
  (search for `public/sounds/sfx`)

These files are included unmodified as separate, independent assets. They are
not statically linked into the Chessco application source; they are loaded at
runtime by the user's browser from `/sounds/practice/`.

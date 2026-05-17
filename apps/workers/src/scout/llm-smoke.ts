/**
 * DeepSeek smoke harness — fires a single realistic chess-matcher prompt at
 * the configured LLM provider and prints the verdict + latency.
 *
 * Purpose: prove the LLM rerank path works end-to-end (key, JSON mode,
 * model output shape) before plugging real cascade output into it. Doesn't
 * require any DB connection or corpus state.
 *
 * Usage (workers .env doesn't have DEEPSEEK_API_KEY; pull it from web):
 *
 *   $env:DEEPSEEK_API_KEY = (Get-Content apps/web/.env.local |
 *     Select-String '^DEEPSEEK_API_KEY=' |
 *     ForEach-Object { ($_ -split '=', 2)[1].Trim('"') })
 *   npx pnpm --filter @chessco/workers exec tsx src/scout/llm-smoke.ts
 *
 * Or with a model override (close-call escalation simulation):
 *
 *   ... ; $env:LLM_SMOKE_MODEL = 'deepseek-reasoner'
 *   npx pnpm --filter @chessco/workers exec tsx src/scout/llm-smoke.ts
 */
import 'dotenv/config';
import { getProseProvider } from './llm-providers';

const PROMPT = `You're judging which online chess account belongs to a known player. The algorithm has already produced ranked candidates with per-signal scores. Your job is to (a) synthesize the evidence holistically and decide the best match, (b) re-rank the candidates by your judgment, and (c) write one short English sentence per candidate explaining the verdict.

SUBJECT: GM Boris Gelfand (ISR) FIDE 2700
MATCHING METHOD: from sample-game stylometric matching (opening repertoire + play quality)

CANDIDATES (3, ranked by algorithm):
[1] lichess/gelfandb
    algorithmic_confidence: 87%
    country: ISR
    title: GM
    ratings: blitz 2680, rapid 2640
    signals: eco-B Najdorf 65%; eco-W e4 78%; cp_loss 14 (matches GM); time blitz dominant
[2] chess.com/borisgelfand
    algorithmic_confidence: 71%
    country: ISR
    title: GM
    ratings: rapid 2720, blitz 2580
    signals: eco-B Najdorf 32%; eco-W catalan 50%; cp_loss 18; time rapid dominant
[3] lichess/bgelfand2003
    algorithmic_confidence: 24%
    country: USA
    ratings: blitz 2100
    signals: eco-B Najdorf 12%; eco-W queens-gambit 40%; cp_loss 42; time bullet dominant

Reasoning guidelines:
- Strong name + country match dominates when present. ECO/opening-sequence overlap is highly identifying; cp-loss disagreement with claimed rating (e.g. claimed GM but cp-loss 100) is a red flag for fake accounts.
- Default to algorithmic ordering; only override with a SPECIFIC structured-signal reason.

Return STRICT JSON in this exact shape — no prose outside the JSON, no markdown:

{
  "verdict": {
    "best_match": "<platform>/<handle>",
    "confidence": "high" | "medium" | "low",
    "reasoning": "One paragraph synthesizing why this is the best match."
  },
  "order": ["<platform>/<handle>", "<platform>/<handle>", "<platform>/<handle>"],
  "prose": {
    "<platform>/<handle>": "One concise sentence (≤25 words) explaining this candidate.",
    "<platform>/<handle>": "...",
    "<platform>/<handle>": "..."
  }
}`;

async function main(): Promise<void> {
  const model = process.env.LLM_SMOKE_MODEL;
  const provider = getProseProvider(model ? { model } : {});
  if (!provider) {
    console.error('No LLM provider configured. Set DEEPSEEK_API_KEY in env.');
    process.exit(1);
  }
  console.log(`[llm-smoke] provider=${provider.name} model=${provider.model}`);
  console.log(`[llm-smoke] prompt length: ${PROMPT.length} chars`);

  const t0 = Date.now();
  let text: string;
  try {
    text = await provider.generate({ prompt: PROMPT, maxTokens: 1200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[llm-smoke] generate failed: ${msg}`);
    process.exit(1);
  }
  const dt = Date.now() - t0;
  console.log(`[llm-smoke] latency: ${dt}ms`);
  console.log(`[llm-smoke] response length: ${text.length} chars`);

  console.log('\n--- raw response ---');
  console.log(text);

  // Try to parse + pretty-print so we know the JSON mode contract held.
  console.log('\n--- parsed verdict ---');
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const verdict = parsed.verdict as Record<string, unknown> | undefined;
    if (verdict) {
      console.log(`best_match : ${verdict.best_match}`);
      console.log(`confidence : ${verdict.confidence}`);
      console.log(`reasoning  : ${verdict.reasoning}`);
    } else {
      console.log('(no verdict block)');
    }
    const order = parsed.order;
    if (Array.isArray(order)) {
      console.log(`order      : ${order.join(', ')}`);
    }
    const prose = parsed.prose;
    if (prose && typeof prose === 'object') {
      console.log('prose:');
      for (const [k, v] of Object.entries(prose as Record<string, unknown>)) {
        console.log(`  ${k}: ${v}`);
      }
    }
  } catch (err) {
    console.log(`(parse failed: ${err instanceof Error ? err.message : String(err)})`);
  }
}

main().catch((err) => {
  console.error('llm-smoke failed:', err);
  process.exit(1);
});

// calm-scalper entrypoint: wires the strategy into the replay shim.
//
// The bot itself lives in strategy.ts (imported first, so the dossier
// opens with the authored code). This file only owns the process wiring:
// speak agent-fun/replay/v2 on stdin/stdout until the harness says done.

import { CalmScalper } from "./strategy.ts";
import { runBot } from "./vendor/makefun-bot.ts";

const scalper = new CalmScalper();

await runBot({
  onBatch(state, batch) {
    // Every decision is a pure function of the batch the harness just
    // delivered, so the two grader executions agree byte for byte.
    return scalper.decide(state, batch);
  },
  onDone() {
    // Nothing to flush: all state lives in the scalper, and the harness
    // already flattened every position before sending done.
  },
});

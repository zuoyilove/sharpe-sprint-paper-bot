// Entry point for the Sharpe-sprint paper bot (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; all logic lives in strategy.ts and the kit SDK
// shim is vendored beside it under vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { buildBot, PARAMS } from './strategy.ts';

await runBot(buildBot(PARAMS));

# sharpe-sprint-paper-bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zuoyilove/sharpe-sprint-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zuoyilove/sharpe-sprint-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun Sharpe sprint, built for a smooth equity curve rather than one lucky moonshot: it ranks by hourly Sharpe ratio, so the bot takes one small position per qualifying curve, exits on a tight trailing stop once a small gain arms (plus a +100% take-profit), never re-enters a curve, and paces tiny probe round trips so the 20-coin guardrail holds even in quiet hours. Entry needs a mature curve with accelerating, broadly-held buy pressure near its window high. Fully deterministic: decisions read only the replay batch stream.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdio (hello, then one reply per batch); run it under the competition kit's harness or grade it locally with the kit CLI's grade-local.

---
<sub>Entered on [make.fun](https://make.fun/?ref=dcz81z7d&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>

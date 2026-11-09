# Roblox Top Trending forecaster

Entry for make.fun's `roblox-trending-forecast-01`: forecasts the top 10 of Roblox's Top Trending chart
(computer, US) for each hour of the 24 hours after entries close. `node main.ts`, Node 22, standard library only.
`main.ts` reads the history and writes the forecast, `model.ts` is the model, `research/` holds the backtest
harness and the hourly recorder used to build and check it (not needed at run time).

## How it works
- Layer 1: a recency-weighted mixture of the recent charts; each observed rank is spread over nearby places by a
  rank-dependent, asymmetric Laplace kernel (top places are sticky, mid-table places churn). Games that have sat on
  the chart for most of a week get a wider downside (the chart measures a week's DAU gain, so an old surge ages out).
- Layer 2: "incumbent drops out" scenarios for the top two games. The long-time #1 (DONT SPLASH) left the chart in
  one read and every game below moved up one place; each scenario deletes one leader from the history, re-runs
  layer 1 and is mixed in with a hazard that grows with the leader's time on the chart.
- No run-time parameter fitting: on this data a nested walk-forward test showed it adds nothing over the fixed
  parameters (-18.85 vs -18.88), and a cross-validated random search found nothing that transferred between
  halves. See STRATEGY.md.

## Run locally
```
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

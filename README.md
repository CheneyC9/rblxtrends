# Roblox Top Trending forecaster

Entry for make.fun's `roblox-trending-forecast-01`: forecasts the top 10 of Roblox's Top Trending chart
(computer, US) for each hour of the 24 hours after entries close. `node main.ts`, Node 22, standard library only.

## How it works
- Recency-weighted mixture of the recent charts; each observed rank is spread over nearby places by a
  rank-dependent, asymmetric Laplace kernel (top places are sticky, mid-table places churn).
- Games that have sat on the chart for most of a week get a wider downside (the chart measures a week's
  DAU gain, so an old surge ages out).
- Parameters are re-fitted at run time on the input history: each read is a cut-off, the reads 1–25 h later
  are scored with the contest's log score, and the best three parameter sets are averaged with the prior.

## Research behind it (Oct 30 – Nov 8, 2026)
- Chart reads: the kit's history plus later reads of the public archive github.com/Kenny-Dhub/roblox-snapshots
  and a live read of the Roblox explore API.
- Player histories from Rolimons and the Brainrot Radar new-game tracker, used to check whether player-count
  momentum predicts rank moves. It correlates (r ≈ −0.22) but did not improve the log score once the kernel
  was calibrated, so the model leaves it out.
- Walk-forward backtest, 21 daily cut-offs: about −18.5 vs −22.2 for the house persistence baseline.

## Run locally
```
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

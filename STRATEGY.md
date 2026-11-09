# Strategy and evidence

Scoring: one forecast, scored at every hourly chart of the 24 h after the history ends, as the mean over charts of
the sum over places of ln P(game actually at that place). So the forecast is a mixture over horizons 0-24 h of
the place marginals, and calibration matters more than sharpness.

## Data
Chart reads Oct 30 - Nov 9, 2026: the kit's history, the public archive github.com/Kenny-Dhub/roblox-snapshots
(every commit of data/discover/latest.json) and my own hourly reads of the Roblox explore API (`research/record.mjs`).
Walk-forward backtest: every read with >= 24 h behind it and >= 2 reads in the next 24 h is a cut-off (33 windows,
overlapping, so the standard error of a mean is about 0.9 nats).

## Findings
- Persistence (the house baseline) -24.6; this model -18.7 on the same windows.
- Calibration (predicted p vs hit rate over 5k+ named games) lies on the diagonal from p = 0.01 to 0.9, so the
  remaining error is discrimination, not calibration.
- Absent games are rare: only 0-14% of places 2-4 and about 2% of places 5-10 are filled by a game that was not on
  the chart at the cut-off, so unnamed mass does not need to be large (raising it only costs).
- Old leaders drop out: of the top-5 games present since the first read, 23% fell 4+ places within a day (14% left the
  chart), against 0-4% for games under 4 days old. DONT SPLASH (#1 for ~7 days) vanished in one read, which is why the
  practice window (Nov 5-6) is hard for every non-hedged forecast. Layer 2 hedges this.
- Dropout hedge (top 2 games, hazard 0.1 x tenure): -18.88 -> -18.65, +0.65 on the later half of the windows, -0.2 on
  the earlier half, better on the worst windows.
- Player-count growth (concurrent players now vs 1/3/7 days ago) correlates only 0.1-0.5 (Spearman) with the chart
  order; it is not used.
- Rejected: run-time grid tuning (nested walk-forward -18.85 vs -18.88 for fixed parameters); parameter ensembles
  over tau or kernel width (all within 0.05 nats); unnamed-mass schedules (worse); a random search over 9 parameters
  did not transfer between the two halves of the windows.
- Ensemble of different algorithm families (`research/families.ts`, `research/stack.mjs`, 37 windows, Nov 9): kernel +
  dropout -18.42, kernel + momentum (alt.ts) -18.08, empirical-Bayes transition model (rank bucket x 12-24 h trend,
  shrunk toward the kernel) -20.44, daily-cycle occupancy model -22.34. Every blend that adds the last two is worse
  than the production 50/50 of the first two (-18.17): linear K,A,M,S 40/40/10/10 -18.44, K,A,S 45/45/10 -18.34,
  K,A,M(strong prior) -18.28, log-linear pooling -18.18 to -18.27. Best weights on one half of the windows do not
  beat 50/50 on the other half by more than 0.1 nat, which is noise (standard error 0.9). So production keeps the two
  families that carry information and gives the others zero weight.
- Does rank slope, player growth or tenure predict a top-15 game's future rank change beyond its current rank?
  Spearman of the residual: 24 h rank slope -0.11 (weak momentum, already in alt.ts), player growth +0.06, tenure
  +0.02 (555 game-windows).
- Other countries' charts correlate 0.4-0.9 with the US chart (recorded hourly in `research/`); whether they lead it
  is being checked and nothing from them is used unless it clears a held-out test.

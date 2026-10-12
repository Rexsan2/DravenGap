# DraftDiff backtesting / calibration harness (RECOMMENDATIONS 1.9)

Checks whether the model's numbers mean what they claim: does a higher Shrunk Δ / PP actually win more, are
predicted win rates calibrated, and which variant should be the default ranking. Standard library only
(`requirements.txt`; matplotlib is optional for the plot).

| File | Purpose |
|---|---|
| `collect_matches.py` | Riot API -> `matches.jsonl` (needs `RIOT_API_KEY`) |
| `evaluate.py` | dataset + matches -> log loss, Brier, accuracy, calibration, PP calibration, rho |
| `simulate.py` | synthetic matches from a known true model, end-to-end self-test (no key needed) |
| `draftdiff_model.py` | Python mirror of the JS model (shared by the above) |

## 1. Collect matches

```
set RIOT_API_KEY=RGAPI-...                      (PowerShell: $env:RIOT_API_KEY="RGAPI-...")
python collect_matches.py --platform euw1 --tiers EMERALD,DIAMOND --max-matches 20000 --out matches.jsonl
```

Seeds players from league-v4 at the chosen tiers, lists their recent ranked-solo (queue 420) matches with match-v5,
fetches each match and keeps non-remake games where each team has exactly one player per `teamPosition`
(UTILITY -> SUPPORT). Champion IDs are mapped to Data Dragon `id` names (`MonkeyKing`, `Fiddlesticks`, ...), the
names the datasets use. Rate limits (dev key 20/s and 100/2min) are enforced client side and 429/`Retry-After` and
5xx are retried with backoff. **Resumable**: re-run the identical command; progress lives in `matches.jsonl` and
`matches.jsonl.state/` (seeds, seen match ids, finished players). A dev key gives ~0.8 requests/s sustained
(about 700 matches/hour including id lookups), so 20k matches take roughly a day; a production key is much faster
(`--limits`). Use `--patch 14.18` to keep one patch, and match the dataset you evaluate against to the patch/time
window of the games (e.g. matches from the last 14 days vs `days_30`).

Record format (blue = teamId 100):
`{"match_id","region","patch","game_start_ms","avg_tier","avg_tier_known","seed_tier","teams":{"blue":{"TOP":..,"JUNGLE":..,"MIDDLE":..,"BOTTOM":..,"SUPPORT":..},"red":{..}},"blue_win":true}`.
Not run yet (no key available) - first run on a few hundred matches (`--max-matches 200`) to confirm the endpoints
still behave as coded (league-v4 entries now return `puuid`; the code falls back to summoner-v4 if only
`summonerId` is present).

## 2. Evaluate

```
python evaluate.py --matches matches.jsonl --r2 days_30/platinum_plus --configs baseline,current --plot calib.png
python evaluate.py --matches matches.jsonl --champion-stats cs.json --matchups mw.json     # local files
```
The dataset comes from a local path/URL or the public bucket (`--r2 <period>/<rank>`, downloaded once to
`~/.cache/draftdiff_backtest`; delete the cached `metadata.json` to refresh it). The 150 MB matchup file loads in
a few seconds and ~1 GB RAM. Use the same `--min-games` as the app (default 300).

### Team-level prediction
For each match and each of the 10 champions the app's quantities are computed against the actual draft (all 9 other
champions as partners). Then, with `w = --weight` (default 0.5):

```
p_blue = clip( 0.5 + [Σ_blue(baseWR-0.5) - Σ_red(baseWR-0.5)] + w·[Σ_blue D - Σ_red D], 0.01, 0.99 )
```
A champion's base WR is its win rate against an average opponent, so base edges add up within a team and the
other team's subtract. Every pairwise delta appears twice in `blue - red` (an ally pair from both partners, an
enemy pair once per side), so `w = 0.5` removes the double counting. The weight scan in the output shows what
the data prefers.

Variants reported per config: **a** `base` (base WR only), **b** `raw` (base + raw Total Δ), **c** `shrunk`
(base + Σ k·d, the quantity PP is built on). The output also includes `dLL vs base` with a paired standard error:
if it is not clearly negative, the variant adds nothing over base WR.

### Metrics
* **Log loss / Brier**: proper scores, lower is better (coin flip: 0.6931 / 0.25). Differences between variants
  are small in absolute terms (win rates are inherently noisy), so look at the paired `dLL` and its SE.
* **Accuracy**: share of games where `p>0.5` matches the winner (only a sanity metric).
* **Calibration deciles / ECE**: games sorted by prediction into 10 equal bins; mean predicted vs actual blue win
  rate, z = difference / binomial SE. ECE = weighted mean |pred - actual|. Calibrated means diff ~ 0 in every bin.
  The plot (`--plot`) is this table as a reliability diagram.
* **Slope**: regress (win - base-only expectation) on `w·Δ_diff`, cluster-robust SE. 1 = the deltas'
  magnitudes are right, <1 = over-confident (typical for raw deltas), >1 = shrunk too much.
* **PP calibration**: PP is "P(true delta sum > 0)" for one champion, which a single game cannot observe. The check
  we use: for every champion instance, `excess_obs = win - p0` where `p0` is the team's base-WR-only win
  probability (from that champion's team's side), versus `excess_model = p_full - p0`. Bucketed by the champion's
  PP, a calibrated, informative PP gives `excess_obs` rising with PP and tracking `excess_model` (z column). Note
  instances from one match share an outcome, so the printed z is optimistic by up to ~sqrt(5).

### Fitting rho (PART1 1.4, design effect `1 + (k-1)·rho`)
Two estimates are printed:
1. **Replication fit** (`--holdout-r2 days_30/emerald_plus` or `--holdout-stats/--holdout-matchups`): outcomes of
   single games carry almost no information about the *variance* of a posterior (a game is Bernoulli with the
   conditional mean whatever the spread of the latent effect - a likelihood fit on game results was tried in
   simulation and returned a wrong rho), so rho is fitted by replication. For each pick the posterior from the main
   dataset is compared with the sum of raw deltas of an independent second dataset on the same pairs:
   `(dB - m)/sqrt((vA + vB)(1+(n-1)rho))` should have variance 1; rho maximises that Gaussian likelihood and
   `mean z^2` is reported before/after. Needs a hold-out that does not share games with the main dataset (e.g.
   previous patch vs current, or a different window); otherwise rho is biased low. Real patch-to-patch drift adds
   variance and biases rho upward.
2. **Analytic estimate** (always printed, dataset only): all of a pick's deltas are win rates over the same games,
   so two deltas share games and their sampling errors correlate by about `sqrt(p_i·p_j)` (p = share of the pick's
   games containing the partner). Averaged over the pairs summed in the sample drafts. On Plat+ 30d this is
   ~0.03, against `PP_DELTA_CORRELATION = 0.1` in the app, so the app is conservative.

## 3. Self-test with simulated matches
```
python simulate.py --champion-stats cs.json --matchups mw.json --n 300000 --true-rho 0.1 --configs baseline,current
```
Drafts are sampled by pick rate; truth for every delta is a draw from its own empirical-Bayes posterior (optionally
with a shared per-pick factor giving correlation `--true-rho`); outcomes are Bernoulli of
`0.5 + base diff + 0.5·true delta diff + N(0, 0.03²)`. A correct harness must give shrunk slope ~ 1, raw slope < 1,
best weight 0.5 for shrunk, calibrated deciles and PP buckets with excess_obs ~ excess_model, and a replication
rho near `--true-rho`. It also writes a synthetic hold-out dataset for the rho fit. See the results in the
implementation report; re-run it whenever the evaluation code changes. This validates the harness, not the model
on real games.

## Keeping Python in sync with index.html
`draftdiff_model.py` mirrors these JS functions in `desktop-app/index.html`. **If any
change, update the Python and re-run `simulate.py`:**

| Python | JS |
|---|---|
| `delta_sampling_variance` | `deltaSamplingVariance` |
| `estimate_prior_variance` | `estimatePriorVariance` (constants `PP_DEFAULT_TAU`, `PP_MIN_TAU`, `PP_MAX_TAU`) |
| `estimate_prior_variance_by_class`, `classify_relationship` | `estimatePriorVarianceByClass`, `classifyRelationship` (`PP_MIN_CLASS_ENTRIES`) |
| `shrink_base_win_rates`, `combo_games` | `shrinkBaseWinRates`, `comboGames` (`BASE_WR_*` constants) |
| `champion_terms` (+ `inflate_variance`) | the posterior loop in `getRecommendations` (min-games filter, partner-must-be-rated, `delta2` old-format fallback, `k = tau2/(tau2+se2)`, `1 + max(n-1,0)·PP_DELTA_CORRELATION`) and the delta sums of `getAnalysis` |
| `normal_cdf` | `normalCdf` (exact `erf` here instead of the A&S approximation) |
| `parse_matchups` / `load_dataset` | dataset loading in `getDataset` (key `[pick, role, partner, partnerRole, relationship]`) |

## Model variants <-> features
Variants are `ModelConfig` objects (`standard_configs` in `draftdiff_model.py`); a new feature is one more config
(or a new field in `champion_terms`). Select with `--configs`.

| Config | tau prior | rho | base WR | Feature |
|---|---|---|---|---|
| `baseline` | pooled tau^2 | 0 | raw | 1.1: shrunk delta / PP as first shipped |
| `perrel` | per class (lane, jungle, duo, enemy, ally) | 0 | raw | 1.2 per-relationship priors |
| `current` | per class | `--rho` (0.1) | raw | + 1.4 correlation inflation (affects PP only, not the means) |
| `current_baseshrink` | per class | `--rho` | shrunk (needs `--total-games` or `games` in the stats file) | + 1.5 base-WR shrinkage |

Not covered yet (not implemented in the JS when this was written): 1.6 rank borrowing (needs a second dataset as
prior mean: add a `ref_ds` argument to `champion_terms`), 1.7 patch blending, 1.3 Exp. WR / P(WR>50%) (the
`shrunk` team prediction here is the corresponding quantity). Note rho and the correlation inflation change only
PP/SD, so `rho` is evaluated through the PP tables and the replication fit, not through log loss.

## Choosing the default ranking
On real data compare `dLL vs base` for `raw` and `shrunk` (and the slopes). If `shrunk` beats `raw`, which is the
expected outcome, keep ranking by Shrunk Δ; if neither beats `base` the matchup deltas add nothing at the chosen
Min Games and the UI should say so. Tune `w` in the weight scan before reading too much into the logloss gap.

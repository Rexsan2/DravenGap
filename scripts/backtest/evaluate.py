#!/usr/bin/env python3
"""Backtest the DraftDiff model on real (or simulated) finished drafts.

For every match we compute, for each of the 10 champions, the quantities the app shows
(base WR, raw total delta, shrunk delta + variance), roll them up into a team-level blue win
probability, and score the predictions against the real result.

Team-level conversion (documented, deliberately simple and linear, like the app's own units):

    base_diff   = sum_blue(baseWR_i - 0.5)  -  sum_red(baseWR_j - 0.5)
    delta_diff  = sum_blue(D_i)             -  sum_red(D_j)          D = raw or shrunk total delta of a champion
    p_blue      = clip(0.5 + base_diff + w * delta_diff, 0.01, 0.99)

* A champion's base WR is its win rate against an average opponent/team, so the five base edges add and the
  opposing team's edges subtract.
* Every pairwise delta shows up twice in (blue sum - red sum): an ally pair is counted from both partners'
  side, an enemy pair once in blue's sum (+d) and once in red's sum (-d). The default weight w = 0.5 undoes
  that double counting. w is scanned (`--weights`) so you can see whether the data wants something else.

Variants (all driven by a ModelConfig in draftdiff_model.py, so new JS features are one line each):
    <cfg>:base    baseline - base WRs only                      (a)
    <cfg>:raw     base + raw total delta (what "Total Δ" shows)  (b)
    <cfg>:shrunk  base + shrunk delta (Σ k·d, what PP uses)      (c)

Usage:
    python evaluate.py --matches matches.jsonl --r2 days_30/platinum_plus
    python evaluate.py --matches m.jsonl --champion-stats cs.json --matchups mw.json --configs baseline,current
"""
import argparse
import json
import math
import sys
import time

from draftdiff_model import (ROLES, PP_DELTA_CORRELATION, load_dataset, standard_configs,
                             champion_terms, inflate_variance, normal_cdf, team_terms)

EPS = 1e-9


# ----------------------------------------------------------------------------- data
def read_matches(path, limit=None):
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = json.loads(line)
            out.append(m)
            if limit and len(out) >= limit:
                break
    return out


def match_teams(m):
    """Accept the collector's format: {'teams': {'blue': {role: champ}, 'red': {...}}, 'blue_win': bool}."""
    t = m['teams']
    return t['blue'], t['red'], 1 if m['blue_win'] else 0


class Records:
    """Pre-computed per-match quantities for one ModelConfig (reused for every weight / variant)."""
    def __init__(self):
        self.ys = []
        self.base_diff = []
        self.raw_diff = []
        self.shr_diff = []
        self.var_blue = []      # per-match: sum over all 10 champions of uninflated posterior variance (rho=0)
        self.champs = []        # per champion instance: (match_idx, side(+1 blue/-1 red), post_mean, var, n)
        self.skipped = 0


def build_records(ds, cfg, matches):
    rec = Records()
    for m in matches:
        blue, red, y = match_teams(m)
        tb = team_terms(ds, cfg, blue, red)
        tr = team_terms(ds, cfg, red, blue)
        if tb is None or tr is None:
            rec.skipped += 1
            continue
        idx = len(rec.ys)
        rec.ys.append(y)
        rec.base_diff.append(sum(t[0] - 0.5 for t in tb) - sum(t[0] - 0.5 for t in tr))
        rec.raw_diff.append(sum(t[1] for t in tb) - sum(t[1] for t in tr))
        rec.shr_diff.append(sum(t[2] for t in tb) - sum(t[2] for t in tr))
        for side, terms in ((1, tb), (-1, tr)):
            for t in terms:
                rec.champs.append((idx, side, t[2], t[3], t[4]))
    return rec


# ----------------------------------------------------------------------------- metrics
def clip_p(p):
    return min(max(p, 0.01), 0.99)


def predict(rec, mode, w, bias=0.0):
    if mode == 'base':
        return [clip_p(0.5 + b + bias) for b in rec.base_diff]
    d = rec.raw_diff if mode == 'raw' else rec.shr_diff
    return [clip_p(0.5 + b + w * x + bias) for b, x in zip(rec.base_diff, d)]


def per_match_logloss(ps, ys):
    return [-(math.log(p) if y else math.log(1 - p)) for p, y in zip(ps, ys)]


def metrics(ps, ys):
    n = len(ys)
    ll = per_match_logloss(ps, ys)
    return {
        'n': n,
        'log_loss': sum(ll) / n,
        'brier': sum((p - y) ** 2 for p, y in zip(ps, ys)) / n,
        'accuracy': sum((p > 0.5) == bool(y) for p, y in zip(ps, ys)) / n,
        'mean_pred': sum(ps) / n,
    }


def calibration_table(ps, ys, bins=10):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    n = len(order)
    rows = []
    for b in range(bins):
        sl = order[b * n // bins:(b + 1) * n // bins]
        if not sl:
            continue
        mp = sum(ps[i] for i in sl) / len(sl)
        ar = sum(ys[i] for i in sl) / len(sl)
        se = math.sqrt(max(ar * (1 - ar), 1e-9) / len(sl))
        rows.append({'n': len(sl), 'lo': ps[sl[0]], 'hi': ps[sl[-1]], 'pred': mp, 'actual': ar, 'se': se})
    ece = sum(r['n'] * abs(r['pred'] - r['actual']) for r in rows) / n
    return rows, ece


def print_calibration(name, rows, ece):
    print('\n  Calibration deciles for %s   (ECE = %.4f)' % (name, ece))
    print('  %-4s %7s %15s %9s %9s %8s %6s' % ('bin', 'n', 'pred range', 'mean pred', 'actual', 'diff', 'z'))
    for i, r in enumerate(rows):
        d = r['actual'] - r['pred']
        print('  %-4d %7d  %5.3f-%5.3f   %9.4f %9.4f %+8.4f %+6.1f' %
              (i + 1, r['n'], r['lo'], r['hi'], r['pred'], r['actual'], d, d / r['se'] if r['se'] else 0))


# ----------------------------------------------------------------------------- PP calibration
def pp_values(rec, rho):
    out = []
    for (_i, _s, m, v, n) in rec.champs:
        if n == 0 or v <= 0:
            out.append(None)
        else:
            out.append(normal_cdf(m / math.sqrt(inflate_variance(v, n, rho))))
    return out


def pp_calibration(rec, w, rho, edges=(0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001)):
    """Does a champion's PP bucket predict that its team beats the base-only expectation?

    PP says P(true delta sum > 0) for one champion's own deltas, which can't be observed per game (each game
    is one Bernoulli outcome shared by 10 champions). The defensible aggregate check is on the *excess over
    base expectation*:
        for every champion instance c on team T:
            y_c    = 1 if T won                  p0_c = P(T wins) from base WRs only
            excess_obs = y_c - p0_c              excess_model = p_full_c - p0_c  (full = base + w * shrunk delta diff)
    Within each PP bucket we compare mean observed excess with mean modelled excess (the delta contribution
    the model claims), plus 'beat_rate' = share of games where the champion's team won more than the
    base-only prediction implied, i.e. P(y=1) vs mean p0. If PP/shrunk deltas carry real signal, excess_obs
    should rise with PP and track excess_model (ratio ~ 1).
    """
    ps0 = predict(rec, 'base', w)
    psf = predict(rec, 'shrunk', w)
    pps = pp_values(rec, rho)
    buckets = [[0, 0.0, 0.0, 0.0, 0.0, 0.0] for _ in range(len(edges) - 1)]  # n, sumPP, sum y, sum p0, sum pf, sum var
    for (idx, side, m, v, n), pp in zip(rec.champs, pps):
        if pp is None:
            continue
        y = rec.ys[idx]
        p0 = ps0[idx]
        pf = psf[idx]
        if side < 0:
            y, p0, pf = 1 - y, 1 - p0, 1 - pf
        for b in range(len(edges) - 1):
            if edges[b] <= pp < edges[b + 1]:
                bk = buckets[b]
                bk[0] += 1
                bk[1] += pp
                bk[2] += y
                bk[3] += p0
                bk[4] += pf
                bk[5] += p0 * (1 - p0)
                break
    rows = []
    for b, bk in enumerate(buckets):
        if bk[0] == 0:
            continue
        n = bk[0]
        # instances inside one match share an outcome, so the naive SE is optimistic; flagged in README
        se = math.sqrt(bk[5]) / n
        rows.append({'lo': edges[b], 'hi': min(edges[b + 1], 1.0), 'n': n, 'mean_pp': bk[1] / n,
                     'actual_wr': bk[2] / n, 'base_expected': bk[3] / n, 'model_expected': bk[4] / n,
                     'excess_obs': (bk[2] - bk[3]) / n, 'excess_model': (bk[4] - bk[3]) / n, 'se': se})
    return rows


def print_pp_calibration(rows, title):
    print('\n  PP calibration (%s)' % title)
    print('  %-9s %8s %7s %9s %9s %9s %9s %9s %6s' %
          ('PP bucket', 'n', 'meanPP', 'actualWR', 'baseExp', 'modelExp', 'exc_obs', 'exc_model', 'z'))
    for r in rows:
        z = (r['excess_obs'] - r['excess_model']) / r['se'] if r['se'] else 0
        print('  %.1f-%.1f %9d %7.3f %9.4f %9.4f %9.4f %+9.4f %+9.4f %+6.1f' %
              (r['lo'], r['hi'], r['n'], r['mean_pp'], r['actual_wr'], r['base_expected'], r['model_expected'],
               r['excess_obs'], r['excess_model'], z))


def delta_slope(rec, w):
    """Cluster-robust slope of the observed excess over base expectation on the model's shrunk delta contribution.

    Per match: e = y - p0 ; x = w * shrunk_delta_diff.  slope ~ 1 -> shrunk deltas are calibrated; <1 -> they are
    over-confident; >1 -> under-confident (could shrink less).  Same for raw deltas for comparison.
    """
    out = {}
    p0 = predict(rec, 'base', w)
    for name, d in (('raw', rec.raw_diff), ('shrunk', rec.shr_diff)):
        sxx = sxe = 0.0
        for y, p, x in zip(rec.ys, p0, d):
            x = w * x
            sxx += x * x
            sxe += x * (y - p)
        beta = sxe / sxx if sxx > 0 else float('nan')
        # sandwich SE with one cluster per match = independent Bernoulli outcomes
        meat = 0.0
        for y, p, x in zip(rec.ys, p0, d):
            x = w * x
            meat += (x * (y - p - beta * x)) ** 2
        out[name] = (beta, math.sqrt(meat) / sxx if sxx > 0 else float('nan'))
    return out


# ----------------------------------------------------------------------------- rho
def fit_rho_replication(ds, ds_hold, cfg, matches, grid=None, max_drafts=20000, min_games_hold=100):
    """Fit the design-effect correlation rho so the posterior variance of a pick's delta SUM is calibrated.

    Why not fit rho on match outcomes?  A game is one Bernoulli draw whose success probability is the
    *conditional mean* of the team effect; uncertainty about that effect does not change the outcome's variance
    (y | features ~ Bernoulli(E[p | features]) whatever the spread of the latent effect), so game results carry
    essentially no information about posterior variance - a likelihood fit on them is biased by the Bernoulli
    variance assumption (we tried it on simulated data: it returned rho = 0 for a true 0.1).  Posterior *means*
    are checkable on games (the slope / PP tables), posterior *variances* are only checkable by replication.

    Replication test: `ds` is the dataset the app would use, `ds_hold` a second dataset measured on different
    games (e.g. the previous patch, or another time window that does not overlap `ds`).  For every pick in the
    sampled drafts, over the pairs present in both datasets:
        m  = sum k_i d_i^A         (shrunk posterior mean from ds)
        vA = sum k_i se_i^2(A)     (posterior variance from ds, uncorrected)
        dB = sum d_i^B             (raw hold-out deltas, an unbiased noisy measure of the same true deltas)
        vB = sum se_i^2(B)
    If the posterior is calibrated, dB - m ~ N(0, (vA + vB) * (1 + (n-1) rho)), z = (dB-m)/sd ~ N(0,1).
    We pick rho by maximising that Gaussian likelihood (the ML estimate is then the rho that makes the PP
    z-scores have unit variance), and report mean(z^2) at rho = 0 and at the fitted rho as a sanity check.
    Caveats: ds and ds_hold must be (nearly) independent samples; overlapping windows bias rho downwards.
    The reported interval treats picks as independent, but picks in different drafts reuse the same matchup
    entries, so it is far too narrow - read it as "the likelihood is sharply peaked", not as a 95% CI.
    Systematic mismatch between the two datasets' normalisation (e.g. different patches with real meta drift)
    adds variance and biases rho upwards; in simulation the bias was about +0.05 at true rho = 0.
    """
    from draftdiff_model import classify_relationship, delta_sampling_variance
    grid = grid or [round(0.01 * i, 2) for i in range(0, 61)]       # 0 .. 0.6
    obs = []        # (resid, v, n)
    for m in matches[:max_drafts]:
        blue, red, _ = match_teams(m)
        for team, enemy in ((blue, red), (red, blue)):
            for role, champ in team.items():
                mA = vA = dB = vB = 0.0
                n = 0
                for t, rel in ((team, 'teammate'), (enemy, 'enemy')):
                    for prole, pc in t.items():
                        if rel == 'teammate' and prole == role:
                            continue
                        key = (champ, role, pc, prole, rel)
                        a = ds.matchups.get(key)
                        b = ds_hold.matchups.get(key)
                        if a is None or b is None or a[2] < cfg.min_games or b[2] < min_games_hold:
                            continue
                        if a[1] is None or b[1] is None:
                            continue
                        tau2 = ds.tau2_by_class.get(classify_relationship(role, prole, rel), ds.tau2_pooled)                             if cfg.tau == 'by_class' else ds.tau2_pooled
                        se2 = delta_sampling_variance(a[0], a[2])
                        k = tau2 / (tau2 + se2)
                        mA += k * a[1]
                        vA += k * se2
                        dB += b[1]
                        vB += delta_sampling_variance(b[0], b[2])
                        n += 1
                if n >= 2:
                    obs.append((dB - mA, vA + vB, n))
    if not obs:
        return None
    lls = []
    for rho in grid:
        ll = 0.0
        for r, v, n in obs:
            s2 = v * (1 + (n - 1) * rho)
            ll += -0.5 * (math.log(s2) + r * r / s2)
        lls.append(ll)
    best = max(range(len(grid)), key=lambda i: lls[i])
    inside = [grid[i] for i in range(len(grid)) if lls[best] - lls[i] <= 1.92]
    z2_0 = sum(r * r / v for r, v, n in obs) / len(obs)
    z2_hat = sum(r * r / (v * (1 + (n - 1) * grid[best])) for r, v, n in obs) / len(obs)
    return {'rho_hat': grid[best], 'ci95_approx': (min(inside), max(inside)), 'n_picks': len(obs),
            'mean_z2_at_rho0': z2_0, 'mean_z2_at_fit': z2_hat, 'at_grid_edge': best in (0, len(grid) - 1)}


def analytic_rho(ds, cfg, matches, max_drafts=20000):
    """Dataset-based estimate of the correlation between a pick's delta sampling errors.

    All of a pick's deltas are win rates over the *same* games (each game contributes to 5 enemy and 4 ally
    matchups). Two deltas i, j then share the games in which both partners occurred, and under independence of
    the partners the sampling-error correlation is sqrt(p_i * p_j), p_i = share of the pick's games that
    contain partner i (games_i / N_pick). Averaging that over the pairs of deltas actually summed in sampled
    drafts gives the rho for the design effect 1 + (k-1)rho. Uses only the dataset and the drafts' champions.
    """
    totals = {}
    for key, (wr, d2, g) in ds.matchups.items():
        tk = (key[0], key[1], key[3], key[4])
        totals[tk] = totals.get(tk, 0) + g
    num = den = 0.0
    used = 0
    for m in matches[:max_drafts]:
        blue, red, _ = match_teams(m)
        for team, enemy in ((blue, red), (red, blue)):
            for role, champ in team.items():
                ps = []
                for t, rel in ((team, 'teammate'), (enemy, 'enemy')):
                    for prole, pc in t.items():
                        if rel == 'teammate' and prole == role:
                            continue
                        st = ds.matchups.get((champ, role, pc, prole, rel))
                        if st is None or st[2] < cfg.min_games:
                            continue
                        tot = totals.get((champ, role, prole, rel), 0)
                        if tot > 0:
                            ps.append(min(st[2] / tot, 1.0))
                k = len(ps)
                if k < 2:
                    continue
                s = sum(math.sqrt(a * b) for i, a in enumerate(ps) for b in ps[i + 1:])
                pairs = k * (k - 1) / 2
                num += s            # sum of pairwise correlations
                den += pairs
                used += 1
    return num / den if den else float('nan')


# ----------------------------------------------------------------------------- plot
def plot_calibration(path, tables, title):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('matplotlib not installed - skipping plot')
        return
    fig, ax = plt.subplots(figsize=(5.5, 5.5))
    ax.plot([0.3, 0.7], [0.3, 0.7], color='#888', lw=1, ls='--', label='perfect')
    for name, rows in tables.items():
        ax.errorbar([r['pred'] for r in rows], [r['actual'] for r in rows], yerr=[1.96 * r['se'] for r in rows],
                    marker='o', ms=4, lw=1.2, capsize=2, label=name)
    ax.set_xlabel('Predicted blue-side win probability (decile mean)')
    ax.set_ylabel('Actual blue-side win rate')
    ax.set_title(title)
    ax.legend(fontsize=8)
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    print('Wrote', path)


# ----------------------------------------------------------------------------- main
def run(ds, matches, configs, weight=0.5, weights=(0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0), plot=None, out_json=None,
        rho_pp=None, quiet=False, ds_hold=None):
    results = {}
    cal_for_plot = {}
    ys_ref = None
    for cname, cfg in configs.items():
        t0 = time.time()
        rec = build_records(ds, cfg, matches)
        n = len(rec.ys)
        if n == 0:
            print('[%s] no usable matches (skipped %d)' % (cname, rec.skipped))
            continue
        ys_ref = rec.ys
        if not quiet:
            print('\n' + '=' * 78)
            print('Config %-20s tau=%s rho=%.3f base=%s min_games=%d   (%d matches used, %d skipped, %.0fs)' %
                  (cname, cfg.tau, cfg.rho, cfg.base, cfg.min_games, n, rec.skipped, time.time() - t0))
            print('  tau2 pooled=%.6f (tau=%.4f)  by class: %s' % (
                ds.tau2_pooled, math.sqrt(ds.tau2_pooled),
                ', '.join('%s=%.4f' % (k, math.sqrt(v)) for k, v in ds.tau2_by_class.items())))
        res = {'n': n, 'skipped': rec.skipped, 'variants': {}}
        blue_wr = sum(rec.ys) / n
        variants = [('base', 'base'), ('raw', 'raw'), ('shrunk', 'shrunk')]
        base_ll = None
        for label, mode in variants:
            ps = predict(rec, mode, weight)
            mt = metrics(ps, rec.ys)
            ll = per_match_logloss(ps, rec.ys)
            if mode == 'base':
                base_ll = ll
                mt['d_logloss_vs_base'] = 0.0
                mt['d_se'] = 0.0
            else:
                diffs = [a - b for a, b in zip(ll, base_ll)]
                md = sum(diffs) / n
                sd = math.sqrt(sum((d - md) ** 2 for d in diffs) / max(n - 1, 1) / n)
                mt['d_logloss_vs_base'] = md
                mt['d_se'] = sd
            rows, ece = calibration_table(ps, rec.ys)
            mt['ece'] = ece
            mt['calibration'] = rows
            res['variants'][label] = mt
            cal_for_plot['%s:%s' % (cname, label)] = rows
        if not quiet:
            print('  blue-side win rate in sample: %.4f   delta weight w=%.2f' % (blue_wr, weight))
            print('  %-8s %9s %9s %9s %9s %14s' % ('variant', 'logloss', 'brier', 'accuracy', 'ECE', 'dLL vs base (se)'))
            for label, _ in variants:
                mt = res['variants'][label]
                print('  %-8s %9.5f %9.5f %9.4f %9.4f   %+.5f (%.5f)' %
                      (label, mt['log_loss'], mt['brier'], mt['accuracy'], mt['ece'], mt['d_logloss_vs_base'], mt['d_se']))
            print('  (reference: coin flip log loss = 0.69315, Brier = 0.25)')
            # weight scan
            print('  log loss vs delta weight w   ' + ' '.join('%7.2f' % w for w in weights))
            for mode in ('raw', 'shrunk'):
                lls = [metrics(predict(rec, mode, w), rec.ys)['log_loss'] for w in weights]
                best = weights[min(range(len(weights)), key=lambda i: lls[i])]
                print('    %-8s                  ' % mode + ' '.join('%7.5f' % l for l in lls) + '   best w=%.2f' % best)
            sl = delta_slope(rec, weight)
            print('  slope of (win - base expectation) on w*delta_diff: raw %.2f +/- %.2f, shrunk %.2f +/- %.2f'
                  '   (1.0 = calibrated)' % (sl['raw'][0], sl['raw'][1], sl['shrunk'][0], sl['shrunk'][1]))
            res['delta_slope'] = {k: {'beta': v[0], 'se': v[1]} for k, v in sl.items()}
            for label in ('shrunk',):
                print_calibration('%s:%s' % (cname, label), res['variants'][label]['calibration'], res['variants'][label]['ece'])
            print_calibration('%s:base' % cname, res['variants']['base']['calibration'], res['variants']['base']['ece'])
            # PP calibration
            use_rho = cfg.rho if rho_pp is None else rho_pp
            pp_rows = pp_calibration(rec, weight, use_rho)
            res['pp_calibration'] = pp_rows
            print_pp_calibration(pp_rows, '%s, rho used for PP = %.3f' % (cname, use_rho))
            # rho fit by replication against a hold-out dataset (optional)
            if ds_hold is not None:
                fit = fit_rho_replication(ds, ds_hold, cfg, matches)
                res['rho_fit'] = fit
                if fit:
                    print('\n  Fitted rho (replication vs hold-out dataset, %d picks): %.2f   approx 95%% interval [%.2f, %.2f]'
                          '   mean z^2: %.2f at rho=0 -> %.2f at fit%s' %
                          (fit['n_picks'], fit['rho_hat'], fit['ci95_approx'][0], fit['ci95_approx'][1],
                           fit['mean_z2_at_rho0'], fit['mean_z2_at_fit'],
                           '   (AT GRID EDGE - widen grid / check hold-out independence)' if fit['at_grid_edge'] else ''))
                else:
                    print('\n  Fitted rho: no overlapping pairs between dataset and hold-out')
            else:
                print('\n  Fitted rho: skipped (pass --holdout-r2 / --holdout-stats+--holdout-matchups for the replication fit)')
            ar = analytic_rho(ds, cfg, matches)
            res['rho_analytic'] = ar
            print('  Analytic rho from game-overlap in the dataset: %.3f   (JS PP_DELTA_CORRELATION = %.2f)' %
                  (ar, PP_DELTA_CORRELATION))
        results[cname] = res
    if plot and cal_for_plot:
        keys = [k for k in cal_for_plot if k.endswith(':base') or k.endswith(':shrunk')]
        plot_calibration(plot, {k: cal_for_plot[k] for k in keys}, 'DraftDiff team-level calibration')
    if out_json:
        with open(out_json, 'w') as f:
            json.dump(results, f, indent=1, default=float)
        print('Wrote', out_json)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--matches', required=True, help='JSONL from collect_matches.py / simulate.py')
    ap.add_argument('--r2', help="dataset on the public bucket as '<period>/<rank>', e.g. days_30/platinum_plus")
    ap.add_argument('--region', default='all')
    ap.add_argument('--champion-stats', help='local path or URL')
    ap.add_argument('--matchups', help='local path or URL')
    ap.add_argument('--cache-dir', help='download cache (default ~/.cache/draftdiff_backtest)')
    ap.add_argument('--total-games', type=int, default=0, help='dataset total games (base-WR shrinkage only)')
    ap.add_argument('--configs', default='baseline,current', help='comma list of: baseline,perrel,current,current_baseshrink')
    ap.add_argument('--min-games', type=int, default=300)
    ap.add_argument('--rho', type=float, default=PP_DELTA_CORRELATION, help='rho used by the "current" configs')
    ap.add_argument('--rho-pp', type=float, default=None, help='override rho used in the PP calibration table')
    ap.add_argument('--weight', type=float, default=0.5, help='delta weight w in the team-level formula')
    ap.add_argument('--holdout-r2', help="independent second dataset '<period>/<rank>' for the rho replication fit")
    ap.add_argument('--holdout-stats')
    ap.add_argument('--holdout-matchups')
    ap.add_argument('--limit', type=int)
    ap.add_argument('--plot', help='write calibration plot PNG (needs matplotlib)')
    ap.add_argument('--out-json')
    a = ap.parse_args(argv)
    if not (a.r2 or (a.champion_stats and a.matchups)):
        ap.error('give --r2 or both --champion-stats and --matchups')
    t0 = time.time()
    ds = load_dataset(a.champion_stats, a.matchups, a.r2, a.region, a.cache_dir, a.total_games)
    print('Dataset %s loaded: %d combos, %d matchup entries (%.0fs)' % (ds.name, len(ds.ratings), len(ds.matchups), time.time() - t0))
    ds_hold = None
    if a.holdout_r2 or (a.holdout_stats and a.holdout_matchups):
        ds_hold = load_dataset(a.holdout_stats, a.holdout_matchups, a.holdout_r2, a.region, a.cache_dir)
        print('Hold-out dataset %s loaded: %d matchup entries' % (ds_hold.name, len(ds_hold.matchups)))
    matches = read_matches(a.matches, a.limit)
    print('%d matches' % len(matches))
    allc = standard_configs(a.min_games, a.rho)
    cfgs = {}
    for name in a.configs.split(','):
        if name not in allc:
            ap.error('unknown config %s (have %s)' % (name, ', '.join(allc)))
        cfgs[name] = allc[name]
    run(ds, matches, cfgs, a.weight, plot=a.plot, out_json=a.out_json, rho_pp=a.rho_pp, ds_hold=ds_hold)


if __name__ == '__main__':
    main()

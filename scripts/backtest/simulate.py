#!/usr/bin/env python3
"""Synthetic end-to-end test of the backtest harness (no Riot API key needed).

Matches are generated from a real DraftDiff dataset with a KNOWN true model:

  * drafts: each role's champion is drawn by that role's pick rate (no champion twice in one game)
  * truth for every matchup delta: a draw from that delta's own empirical-Bayes posterior
        true_d = k*d + sqrt(k*se^2) * (sqrt(rho_true)*z_pick + sqrt(1-rho_true)*eps)
    (z_pick is one shared N(0,1) per pick, which makes a pick's deltas positively correlated when rho_true > 0)
    with the reverse direction forced consistent (enemy: -d, teammate: +d)
  * outcome: P(blue wins) = 0.5 + sum_blue(base-0.5) - sum_red(base-0.5) + w_true*(sum_blue TD - sum_red TD)
             + N(0, extra_noise^2)   [unmodelled skill / randomness];   y ~ Bernoulli(P)

Because the generating model is the one the harness assumes, a correct harness must show:
  - shrunk-delta slope near 1 (raw-delta slope below 1: raw deltas are over-confident),
  - the best delta weight near w_true,
  - well calibrated deciles for 'shrunk', and PP buckets whose observed excess tracks the modelled excess.

    python simulate.py --champion-stats cs.json --matchups mw.json --n 100000 --out sim.jsonl
"""
import argparse
import bisect
import json
import math
import random
import time

from draftdiff_model import ROLES, load_dataset, standard_configs, classify_relationship, delta_sampling_variance
import evaluate


class Sampler:
    def __init__(self, ds):
        self.cum = {}
        self.names = {}
        for role in ROLES:
            items = [(it['champion'], it['pick_rate']) for it in ds.stats_list
                     if it['role'].upper() == role and (it.get('pick_rate') or 0) > 0]
            tot = 0.0
            cum = []
            for _, pr in items:
                tot += pr
                cum.append(tot)
            self.cum[role] = cum
            self.names[role] = [c for c, _ in items]

    def draft(self, rng):
        used = set()
        team = {}
        for role in ROLES:
            while True:
                cum = self.cum[role]
                i = bisect.bisect_left(cum, rng.random() * cum[-1])
                c = self.names[role][min(i, len(cum) - 1)]
                if c not in used:
                    used.add(c)
                    team[role] = c
                    break
        return team


class Truth:
    def __init__(self, ds, min_games, rho_true, rng):
        self.ds, self.min_games, self.rho, self.rng = ds, min_games, rho_true, rng
        self.cache = {}
        self.z = {}

    def _pick_factor(self, pick):
        if pick not in self.z:
            self.z[pick] = self.rng.gauss(0, 1)
        return self.z[pick]

    def delta(self, c, r, p, pr, rel):
        key = (c, r, p, pr, rel)
        rev = (p, pr, c, r, rel)
        canon, sign = (key, 1) if key <= rev else (rev, -1 if rel == 'enemy' else 1)
        if canon not in self.cache:
            st = self.ds.matchups.get(canon)
            if st is None or st[2] < self.min_games:
                self.cache[canon] = 0.0
            else:
                wr, d2, g = st
                tau2 = self.ds.tau2_by_class.get(classify_relationship(canon[1], canon[3], rel), self.ds.tau2_pooled)
                se2 = delta_sampling_variance(wr, g)
                k = tau2 / (tau2 + se2)
                d = d2 if d2 is not None else 0.0
                # the reverse entry measures the same games (corr ~0.85-0.95 in real data): average the two views
                rst = self.ds.matchups.get((canon[2], canon[3], canon[0], canon[1], rel))
                if rst is not None and rst[1] is not None and rst[2] >= self.min_games:
                    d = 0.5 * (d + (-rst[1] if rel == 'enemy' else rst[1]))
                sd = math.sqrt(k * se2)
                eps = self.rng.gauss(0, 1)
                zp = self._pick_factor((canon[0], canon[1]))
                self.cache[canon] = k * d + sd * (math.sqrt(self.rho) * zp + math.sqrt(1 - self.rho) * eps)
        return sign * self.cache[canon]


def team_true_delta(truth, team, enemy):
    tot = 0.0
    for role, c in team.items():
        for prole, pc in team.items():
            if prole != role:
                tot += truth.delta(c, role, pc, prole, 'teammate')
        for prole, pc in enemy.items():
            tot += truth.delta(c, role, pc, prole, 'enemy')
    return tot


def make_holdout(ds, truth, rng, rho_noise):
    """Synthetic independent re-measurement of every delta: truth + sampling noise with the same game counts
    (noise shares one N(0,1) factor per pick with weight rho_noise, mimicking the shared-games correlation)."""
    from draftdiff_model import Dataset
    zb = {}
    mu = {}
    for key, (wr, d2, g) in ds.matchups.items():
        if g < truth.min_games:
            mu[key] = (wr, d2, g)
            continue
        pk = (key[0], key[1])
        if pk not in zb:
            zb[pk] = rng.gauss(0, 1)
        sd = math.sqrt(delta_sampling_variance(wr, g))
        noise = sd * (math.sqrt(rho_noise) * zb[pk] + math.sqrt(1 - rho_noise) * rng.gauss(0, 1))
        mu[key] = (wr, truth.delta(*key) + noise, g)
    return Dataset(ds.stats_list, mu, ds.total_games, name='synthetic-holdout')


def generate(ds, n, seed, min_games, w_true, extra_noise, rho_true, out_path):
    rng = random.Random(seed)
    sampler = Sampler(ds)
    truth = Truth(ds, min_games, rho_true, rng)
    matches = []
    for i in range(n):
        while True:
            blue, red = sampler.draft(rng), sampler.draft(rng)
            if not set(blue.values()) & set(red.values()):
                break
        base = sum(ds.ratings[(c, r)]['win_rate'] - 0.5 for r, c in blue.items()) - \
            sum(ds.ratings[(c, r)]['win_rate'] - 0.5 for r, c in red.items())
        td = team_true_delta(truth, blue, red) - team_true_delta(truth, red, blue)
        p = 0.5 + base + w_true * td + rng.gauss(0, extra_noise)
        p = min(max(p, 0.02), 0.98)
        win = rng.random() < p
        matches.append({'match_id': 'SIM_%d' % i, 'patch': 'sim', 'teams': {'blue': blue, 'red': red},
                        'blue_win': win, 'true_p': p})
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            for m in matches:
                f.write(json.dumps(m) + '\n')
    return matches, truth, rng


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--champion-stats')
    ap.add_argument('--matchups')
    ap.add_argument('--r2')
    ap.add_argument('--total-games', type=int, default=0, help='dataset total games (only for base-WR shrinkage)')
    ap.add_argument('--n', type=int, default=100000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--min-games', type=int, default=300)
    ap.add_argument('--true-w', type=float, default=0.5, help='true weight of delta sums (model assumes 0.5)')
    ap.add_argument('--extra-noise', type=float, default=0.03, help='SD of unmodelled team-strength noise on P(win)')
    ap.add_argument('--true-rho', type=float, default=0.0, help='correlation between a pick\'s true deltas')
    ap.add_argument('--no-holdout', action='store_true', help='skip the synthetic hold-out dataset / rho replication fit')
    ap.add_argument('--configs', default='baseline,current')
    ap.add_argument('--out', help='write the matches JSONL here')
    ap.add_argument('--plot')
    ap.add_argument('--out-json')
    a = ap.parse_args()
    t0 = time.time()
    ds = load_dataset(a.champion_stats, a.matchups, a.r2, total_games=a.total_games)
    print('Dataset loaded: %d combos, %d matchups (%.0fs); tau pooled=%.4f' %
          (len(ds.ratings), len(ds.matchups), time.time() - t0, math.sqrt(ds.tau2_pooled)))
    t0 = time.time()
    matches, truth, rng = generate(ds, a.n, a.seed, a.min_games, a.true_w, a.extra_noise, a.true_rho, a.out)
    print('Generated %d matches (%.0fs): blue win rate %.4f, true-p SD %.4f' % (
        len(matches), time.time() - t0, sum(m['blue_win'] for m in matches) / len(matches),
        math.sqrt(sum((m['true_p'] - 0.5) ** 2 for m in matches) / len(matches))))
    allc = standard_configs(a.min_games)
    cfgs = {k: allc[k] for k in a.configs.split(',')}
    ds_hold = make_holdout(ds, truth, rng, a.true_rho) if not a.no_holdout else None
    evaluate.run(ds, matches, cfgs, 0.5, plot=a.plot, out_json=a.out_json, ds_hold=ds_hold)
    # oracle: how good could any predictor be?
    ps = [m['true_p'] for m in matches]
    ys = [1 if m['blue_win'] else 0 for m in matches]
    mt = evaluate.metrics(ps, ys)
    print('\nOracle (true generating probability): logloss %.5f brier %.5f acc %.4f' %
          (mt['log_loss'], mt['brier'], mt['accuracy']))


if __name__ == '__main__':
    main()

"""Python mirror of the DraftDiff statistical model in desktop-app/index.html.

KEEP IN SYNC with the JS.  Mirrored JS functions (see README for details):
  deltaSamplingVariance, estimatePriorVariance, estimatePriorVarianceByClass,
  classifyRelationship, normalCdf, comboGames, shrinkBaseWinRates,
  and the posterior loop of getRecommendations / the delta sums of getAnalysis.

Pure standard library.
"""
import json
import math
import os
import urllib.request

ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT']
R2_PUBLIC_URL = 'https://pub-1efd88d862814361909e5510d7af1c1a.r2.dev'

# --- constants copied from index.html ---
PP_DEFAULT_TAU = 0.02
PP_MIN_TAU = 0.005
PP_MAX_TAU = 0.05
PP_MIN_CLASS_ENTRIES = 200
PP_REL_CLASSES = ['lane', 'jungle', 'duo', 'enemy', 'ally']
PP_DELTA_CORRELATION = 0.1
BASE_WR_DEFAULT_TAU = 0.015
BASE_WR_MIN_TAU = 0.005
BASE_WR_MAX_TAU = 0.05


# ----------------------------------------------------------------------------- maths
def normal_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def delta_sampling_variance(win_rate, total_games):
    """JS deltaSamplingVariance."""
    wr = win_rate if (win_rate is not None and 0 < win_rate < 1) else 0.5
    return wr * (1 - wr) / total_games


def classify_relationship(pick_role, partner_role, relationship):
    """JS classifyRelationship."""
    if relationship == 'enemy':
        if pick_role == partner_role:
            return 'lane'
        if pick_role == 'JUNGLE' or partner_role == 'JUNGLE':
            return 'jungle'
        return 'enemy'
    if (pick_role == 'BOTTOM' and partner_role == 'SUPPORT') or (pick_role == 'SUPPORT' and partner_role == 'BOTTOM'):
        return 'duo'
    return 'ally'


def _tau2_from_accum(n, s, ss, noise):
    mean = s / n
    tau2 = ss / n - mean * mean - noise / n
    return min(max(tau2, PP_MIN_TAU ** 2), PP_MAX_TAU ** 2)


def estimate_prior_variance(matchups):
    """JS estimatePriorVariance. matchups: dict key-tuple -> (win_rate, delta2|None, games)."""
    n = 0
    s = ss = noise = 0.0
    for (wr, d2, games) in matchups.values():
        if d2 is None or games < 100:
            continue
        n += 1
        s += d2
        ss += d2 * d2
        noise += delta_sampling_variance(wr, games)
    if n < 50:
        return PP_DEFAULT_TAU ** 2
    return _tau2_from_accum(n, s, ss, noise)


def estimate_prior_variance_by_class(matchups, pooled):
    """JS estimatePriorVarianceByClass."""
    acc = {c: [0, 0.0, 0.0, 0.0] for c in PP_REL_CLASSES}
    for key, (wr, d2, games) in matchups.items():
        if d2 is None or games < 100:
            continue
        a = acc[classify_relationship(key[1], key[3], key[4])]
        a[0] += 1
        a[1] += d2
        a[2] += d2 * d2
        a[3] += delta_sampling_variance(wr, games)
    out = {}
    for c in PP_REL_CLASSES:
        n, s, ss, noise = acc[c]
        out[c] = pooled if n < PP_MIN_CLASS_ENTRIES else _tau2_from_accum(n, s, ss, noise)
    return out


def combo_games(item, total_games):
    """JS comboGames."""
    if (item.get('games') or 0) > 0:
        return item['games']
    pr = item.get('pick_rate', 0) or 0
    return pr * total_games if (pr > 0 and total_games > 0) else 0


def shrink_base_win_rates(stats_list, total_games):
    """JS shrinkBaseWinRates. Returns {(champ, role): shrunk_wr}."""
    by_role = {}
    for item in stats_list:
        role = item['role'].upper()
        n = combo_games(item, total_games)
        wr = item['win_rate']
        by_role.setdefault(role, []).append((item, n, wr, n > 0 and 0 < wr < 1))
    result = {}
    for role, rows in by_role.items():
        valid = [r for r in rows if r[3]]
        m = 0.5
        tau2 = BASE_WR_DEFAULT_TAU ** 2
        if len(valid) >= 10:
            sum_n = sum(r[1] for r in valid)
            m = sum(r[1] * r[2] for r in valid) / sum_n
            sw = sw2 = q = 0.0
            for _, n, wr, _ok in valid:
                w = n / (wr * (1 - wr))
                sw += w
                sw2 += w * w
                q += w * (wr - m) ** 2
            raw = (q - (len(valid) - 1)) / (sw - sw2 / sw)
            tau2 = min(max(raw, BASE_WR_MIN_TAU ** 2), BASE_WR_MAX_TAU ** 2)
        for item, n, wr, ok in rows:
            key = (item['champion'], role)
            if not ok:
                result[key] = wr
                continue
            se2 = wr * (1 - wr) / n
            k = tau2 / (tau2 + se2)
            result[key] = m + k * (wr - m)
    return result


# ----------------------------------------------------------------------------- dataset
class Dataset:
    def __init__(self, stats_list, matchups, total_games=0, name=''):
        self.name = name
        self.stats_list = stats_list
        self.matchups = matchups          # (pick, prole, partner, partnerrole, rel) -> (wr, delta2|None, games)
        self.ratings = {}                 # (champ, role) -> item dict
        for it in stats_list:
            self.ratings[(it['champion'], it['role'].upper())] = it
        self.total_games = total_games
        self.tau2_pooled = estimate_prior_variance(matchups)
        self.tau2_by_class = estimate_prior_variance_by_class(matchups, self.tau2_pooled)
        self._base_shrunk = None

    def base_wr(self, champ, role, mode='raw'):
        it = self.ratings.get((champ, role))
        if it is None:
            return None
        if mode == 'shrunk':
            if self._base_shrunk is None:
                self._base_shrunk = shrink_base_win_rates(self.stats_list, self.total_games)
            return self._base_shrunk.get((champ, role), it['win_rate'])
        return it['win_rate']


def _load_json(path_or_url, cache_dir=None):
    if str(path_or_url).startswith('http'):
        cache_dir = cache_dir or os.path.join(os.path.expanduser('~'), '.cache', 'draftdiff_backtest')
        os.makedirs(cache_dir, exist_ok=True)
        local = os.path.join(cache_dir, path_or_url.replace('https://', '').replace('/', '__'))
        if not os.path.exists(local):
            print('Downloading %s ...' % path_or_url)
            req = urllib.request.Request(path_or_url, headers={'User-Agent': 'DraftDiff-backtest/1.0'})
            with urllib.request.urlopen(req) as resp, open(local, 'wb') as out:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
        path_or_url = local
    with open(path_or_url, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_matchups(raw):
    out = {}
    for key, v in raw.items():
        parts = key[2:-2].split('","')          # '["A","TOP","B","TOP","enemy"]'
        if len(parts) != 5:
            parts = json.loads(key)
        out[tuple(parts)] = (v.get('win_rate'), v.get('delta2'), v.get('total_games') or 0)
    return out


def load_dataset(stats_path=None, matchups_path=None, r2=None, region='all', cache_dir=None, total_games=0):
    """Either explicit local paths/URLs, or r2='days_30/platinum_plus' (period/rank) from the public bucket."""
    if r2:
        base = '%s/%s/%s' % (R2_PUBLIC_URL, r2, region)
        stats_path = stats_path or base + '/champion_stats.json'
        matchups_path = matchups_path or base + '/matchup_winrates.json'
        if not total_games:
            try:
                meta = _load_json(R2_PUBLIC_URL + '/metadata.json', cache_dir)
                period, rank = r2.split('/')
                key = ('30_' if period == 'days_30' else 'patch_') + rank
                total_games = meta.get('total_games_by_dataset', {}).get(key, 0)
            except Exception as e:  # metadata is optional (only used for base-WR shrinkage)
                print('metadata.json unavailable:', e)
    stats = _load_json(stats_path, cache_dir)
    raw = _load_json(matchups_path, cache_dir)
    matchups = parse_matchups(raw)
    del raw
    return Dataset(stats, matchups, total_games, name=r2 or os.path.basename(str(matchups_path)))


# ----------------------------------------------------------------------------- model
class ModelConfig:
    """A pluggable model variant.

    tau        : 'pooled' (feature 1.1 baseline) | 'by_class' (feature 1.2 per-relationship priors)
    rho        : design-effect correlation, variance *= 1 + (n-1)*rho (feature 1.4)
    base       : 'raw' | 'shrunk' (feature 1.5 base-WR shrinkage)
    min_games  : the UI 'Min Games' filter
    """
    def __init__(self, name, tau='pooled', rho=0.0, base='raw', min_games=300):
        self.name, self.tau, self.rho, self.base, self.min_games = name, tau, rho, base, min_games


def standard_configs(min_games=300, rho=PP_DELTA_CORRELATION):
    return {
        'baseline': ModelConfig('baseline', 'pooled', 0.0, 'raw', min_games),        # PP as first shipped (1.1)
        'perrel': ModelConfig('perrel', 'by_class', 0.0, 'raw', min_games),          # + 1.2
        'current': ModelConfig('current', 'by_class', rho, 'raw', min_games),        # + 1.4
        'current_baseshrink': ModelConfig('current_baseshrink', 'by_class', rho, 'shrunk', min_games),  # + 1.5
    }


def champion_terms(ds, cfg, champ, role, allies, enemies):
    """Terms for one champion in a given draft.

    allies / enemies: dict role -> champion (allies may contain the champion itself; it is skipped).
    Returns None if the champion has no rating, else
      (base_wr, raw_sum, post_mean, post_var_uncorrected, n_deltas)
    Mirrors the loops in getRecommendations (posterior) and getAnalysis (raw sums), including the delta2
    old-format fallback, the partner-must-have-a-rating rule and the min-games filter.
    """
    base = ds.base_wr(champ, role, cfg.base)
    if base is None:
        return None
    raw_sum = 0.0
    post_mean = 0.0
    post_var = 0.0
    n = 0
    for team, rel in ((allies, 'teammate'), (enemies, 'enemy')):
        for prole, pchamp in team.items():
            if not pchamp or (rel == 'teammate' and prole == role):
                continue
            pbase = ds.base_wr(pchamp, prole, cfg.base)
            if pbase is None:
                continue
            st = ds.matchups.get((champ, role, pchamp, prole, rel))
            if st is None:
                continue
            wr, d2, games = st
            if games < cfg.min_games:
                continue
            d = d2
            if d is None:     # old dataset format fallback
                d = wr - (0.5 + (base - 0.5) + ((pbase - 0.5) if rel == 'teammate' else -(pbase - 0.5)))
            raw_sum += d
            se2 = delta_sampling_variance(wr, games)
            if cfg.tau == 'by_class':
                tau2 = ds.tau2_by_class.get(classify_relationship(role, prole, rel), ds.tau2_pooled)
            else:
                tau2 = ds.tau2_pooled
            k = tau2 / (tau2 + se2)
            post_mean += k * d
            post_var += k * se2
            n += 1
    return (base, raw_sum, post_mean, post_var, n)


def inflate_variance(var, n, rho):
    """JS: shrunkVar = postVar * (1 + max(ppCount-1,0) * PP_DELTA_CORRELATION)."""
    return var * (1 + max(n - 1, 0) * rho)


def team_terms(ds, cfg, team, enemy):
    """Per-champion terms for one side (dicts role->champ). Returns a list, or None if any champion is unrated."""
    out = []
    for role, champ in team.items():
        t = champion_terms(ds, cfg, champ, role, team, enemy)
        if t is None:
            return None
        out.append(t)
    return out

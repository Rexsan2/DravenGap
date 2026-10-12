#!/usr/bin/env python3
"""Collect finished ranked solo-queue matches from the Riot API into a JSONL file for evaluate.py.

Needs a Riot API key in the environment variable RIOT_API_KEY (never hard-coded, never logged).
Standard library only. Resumable: re-run the same command and it continues where it stopped.

Pipeline
  1. Seed players at the chosen tier(s)      league-v4  /lol/league/v4/entries/RANKED_SOLO_5x5/{TIER}/{DIVISION}?page=N
                                             (apex: /lol/league/v4/{challenger|grandmaster|master}leagues/by-queue/RANKED_SOLO_5x5)
                                             entries carry `puuid` (older responses only `summonerId`; then we resolve it
                                             with summoner-v4 /lol/summoner/v4/summoners/{summonerId}).
  2. Recent ranked match ids per player      match-v5   /lol/match/v5/matches/by-puuid/{puuid}/ids?queue=420&type=ranked
  3. Full match                              match-v5   /lol/match/v5/matches/{matchId}
  4. Keep: queueId 420, not a remake / early surrender, exactly one player per teamPosition per team.
     championId -> Data Dragon `id` (e.g. 'MonkeyKing' for Wukong), the same names the DraftDiff datasets use.

Output (one JSON object per line):
  {"match_id": "EUW1_123", "region": "euw1", "patch": "14.18", "game_start_ms": 1726000000000,
   "avg_tier": 11.4, "avg_tier_known": 4, "seed_tier": "EMERALD",
   "teams": {"blue": {"TOP": "Aatrox", "JUNGLE": ..., "MIDDLE": ..., "BOTTOM": ..., "SUPPORT": ...}, "red": {...}},
   "blue_win": true}
  blue = teamId 100, red = teamId 200.  avg_tier is the mean tier score (IRON IV = 0 ... DIAMOND I = 15,
  MASTER = 16, GRANDMASTER = 17, CHALLENGER = 18) over the participants whose rank we know from seeding
  (null if none); it is only a rough indicator because most opponents are not seeds.

Rate limits: development key = 20 requests / 1 s and 100 requests / 120 s. Both are enforced client-side
(with a safety factor) and HTTP 429 responses are honoured via Retry-After with exponential backoff.
Production keys have higher limits: override with --limits "500/10,30000/600".

Example
  set RIOT_API_KEY=RGAPI-...            (Windows)      export RIOT_API_KEY=RGAPI-...   (bash)
  python collect_matches.py --platform euw1 --tiers EMERALD,DIAMOND --max-matches 20000 --out matches_euw_emd.jsonl
"""
import argparse
import collections
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PLATFORM_TO_REGION = {
    'na1': 'americas', 'br1': 'americas', 'la1': 'americas', 'la2': 'americas',
    'kr': 'asia', 'jp1': 'asia',
    'euw1': 'europe', 'eun1': 'europe', 'tr1': 'europe', 'ru': 'europe',
    'oc1': 'sea', 'ph2': 'sea', 'sg2': 'sea', 'th2': 'sea', 'tw2': 'sea', 'vn2': 'sea',
}
TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND']
APEX = {'MASTER': 'masterleagues', 'GRANDMASTER': 'grandmasterleagues', 'CHALLENGER': 'challengerleagues'}
DIVISIONS = ['IV', 'III', 'II', 'I']
POSITION_MAP = {'TOP': 'TOP', 'JUNGLE': 'JUNGLE', 'MIDDLE': 'MIDDLE', 'BOTTOM': 'BOTTOM', 'UTILITY': 'SUPPORT'}
ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT']
RANKED_SOLO_QUEUE_ID = 420
DDRAGON_VERSIONS = 'https://ddragon.leagueoflegends.com/api/versions.json'
DDRAGON_CHAMPS = 'https://ddragon.leagueoflegends.com/cdn/{v}/data/en_US/champion.json'


def tier_score(tier, division):
    if tier in TIERS:
        return TIERS.index(tier) * 4 + (3 - DIVISIONS.index(division) if division in DIVISIONS else 0)
    return {'MASTER': 16, 'GRANDMASTER': 17, 'CHALLENGER': 18}.get(tier)


class FatalApiError(Exception):
    pass


class RateLimiter:
    """Sliding-window limiter for several (max_requests, window_seconds) limits."""
    def __init__(self, limits, safety=0.9):
        self.limits = [(max(1, int(n * safety)), w) for n, w in limits]
        self.hist = [collections.deque() for _ in self.limits]
        self.blocked_until = 0.0

    def wait(self):
        while True:
            now = time.monotonic()
            delay = max(0.0, self.blocked_until - now)
            for (n, w), h in zip(self.limits, self.hist):
                while h and now - h[0] >= w:
                    h.popleft()
                if len(h) >= n:
                    delay = max(delay, w - (now - h[0]) + 0.01)
            if delay <= 0:
                now = time.monotonic()
                for h in self.hist:
                    h.append(now)
                return
            time.sleep(delay)

    def penalize(self, seconds):
        self.blocked_until = max(self.blocked_until, time.monotonic() + seconds)


class Riot:
    def __init__(self, key, platform, limiter, verbose=False):
        self.key = key
        self.platform = platform
        self.region = PLATFORM_TO_REGION[platform]
        self.limiter = limiter
        self.verbose = verbose
        self.requests = 0

    def get(self, host, path, params=None, max_tries=6):
        url = 'https://%s.api.riotgames.com%s' % (host, path)
        if params:
            url += '?' + urllib.parse.urlencode(params)
        backoff = 1.0
        for attempt in range(max_tries):
            self.limiter.wait()
            self.requests += 1
            req = urllib.request.Request(url, headers={'X-Riot-Token': self.key, 'Accept': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                code = e.code
                if code == 404:
                    return None
                if code == 429:
                    ra = e.headers.get('Retry-After')
                    wait = float(ra) if ra else backoff
                    wait += random.random() * 0.5
                    print('  429 rate limited, sleeping %.1fs' % wait, file=sys.stderr)
                    self.limiter.penalize(wait)       # Retry-After applies to every request, not only this one
                    backoff = min(backoff * 2, 60)
                    continue
                if code in (401, 403):
                    raise FatalApiError('HTTP %d from %s - API key invalid/expired or endpoint not permitted' % (code, path))
                if code >= 500 or code == 408:
                    time.sleep(backoff + random.random())
                    backoff = min(backoff * 2, 60)
                    continue
                print('  HTTP %d for %s - skipping' % (code, path), file=sys.stderr)
                return None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                print('  network error (%s), retrying' % e, file=sys.stderr)
                time.sleep(backoff + random.random())
                backoff = min(backoff * 2, 60)
        print('  giving up on %s' % path, file=sys.stderr)
        return None

    # --- league-v4
    def league_entries(self, tier, division, page):
        return self.get(self.platform, '/lol/league/v4/entries/RANKED_SOLO_5x5/%s/%s' % (tier, division), {'page': page}) or []

    def apex_entries(self, tier):
        data = self.get(self.platform, '/lol/league/v4/%s/by-queue/RANKED_SOLO_5x5' % APEX[tier])
        return (data or {}).get('entries', [])

    def puuid_from_summoner_id(self, sid):
        d = self.get(self.platform, '/lol/summoner/v4/summoners/%s' % sid)
        return (d or {}).get('puuid')

    # --- match-v5
    def match_ids(self, puuid, start_time, end_time, count=100):
        params = {'queue': RANKED_SOLO_QUEUE_ID, 'type': 'ranked', 'start': 0, 'count': count}
        if start_time:
            params['startTime'] = int(start_time)
        if end_time:
            params['endTime'] = int(end_time)
        return self.get(self.region, '/lol/match/v5/matches/by-puuid/%s/ids' % puuid, params) or []

    def match(self, match_id):
        return self.get(self.region, '/lol/match/v5/matches/%s' % match_id)


# ----------------------------------------------------------------------------- Data Dragon
def load_champion_map(state_dir, version=None):
    cache = os.path.join(state_dir, 'champion_map.json')
    if os.path.exists(cache) and not version:
        with open(cache, 'r', encoding='utf-8') as f:
            return json.load(f)
    def fetch(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'DraftDiff-backtest/1.0'}), timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    version = version or fetch(DDRAGON_VERSIONS)[0]
    data = fetch(DDRAGON_CHAMPS.format(v=version))['data']
    mapping = {int(c['key']): c['id'] for c in data.values()}      # 'key' is the numeric championId, 'id' the DDragon name
    with open(cache, 'w', encoding='utf-8') as f:
        json.dump({str(k): v for k, v in mapping.items()}, f)
    print('Loaded %d champions from Data Dragon %s' % (len(mapping), version))
    return {str(k): v for k, v in mapping.items()}


# ----------------------------------------------------------------------------- parsing
def parse_match(data, champ_map, region_label, seed_info):
    """Return a record dict, or (None, reason)."""
    info = (data or {}).get('info')
    if not info:
        return None, 'no info'
    if info.get('queueId') != RANKED_SOLO_QUEUE_ID:
        return None, 'queue'
    parts = info.get('participants', [])
    if len(parts) != 10:
        return None, 'participants'
    duration = info.get('gameDuration', 0)
    if info.get('gameEndTimestamp') is None:          # old matches report milliseconds; new ones seconds
        duration = duration / 1000.0
    if duration < 300 or any(p.get('gameEndedInEarlySurrender') for p in parts):
        return None, 'remake'
    teams = {100: {}, 200: {}}
    wins = {}
    for p in parts:
        pos = POSITION_MAP.get(p.get('teamPosition', ''))
        if pos is None:
            return None, 'position'
        cid = str(p.get('championId'))
        name = champ_map.get(cid) or (p.get('championName') or '').replace(' ', '')
        if not name:
            return None, 'champion'
        t = teams.get(p.get('teamId'))
        if t is None or pos in t:
            return None, 'position'
        t[pos] = name
        wins[p['teamId']] = bool(p.get('win'))
    if any(sorted(t) != sorted(ROLES) for t in teams.values()) or wins.get(100) == wins.get(200):
        return None, 'inconsistent'
    scores = [seed_info[p['puuid']][1] for p in parts if p.get('puuid') in seed_info and seed_info[p['puuid']][1] is not None]
    seed_tiers = [seed_info[p['puuid']][0] for p in parts if p.get('puuid') in seed_info]
    gv = info.get('gameVersion', '')
    return {
        'match_id': data['metadata']['matchId'],
        'region': region_label,
        'patch': '.'.join(gv.split('.')[:2]),
        'game_start_ms': info.get('gameStartTimestamp') or info.get('gameCreation'),
        'avg_tier': round(sum(scores) / len(scores), 2) if scores else None,
        'avg_tier_known': len(scores),
        'seed_tier': collections.Counter(seed_tiers).most_common(1)[0][0] if seed_tiers else None,
        'teams': {'blue': teams[100], 'red': teams[200]},
        'blue_win': wins[100],
    }, None


# ----------------------------------------------------------------------------- state helpers
def read_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, 'r', encoding='utf-8') as f:
        return [l.strip() for l in f if l.strip()]


def append_line(path, line):
    with open(path, 'a', encoding='utf-8') as f:
        f.write(line + '\n')
        f.flush()


def seed_players(api, args, state_dir):
    seeds_path = os.path.join(state_dir, 'seeds.jsonl')
    done_marker = os.path.join(state_dir, 'seeds.done')
    if os.path.exists(done_marker):
        return [json.loads(l) for l in read_lines(seeds_path)]
    open(seeds_path, 'w').close()
    seeds = []
    seen = set()

    def add(entry, tier, division):
        puuid = entry.get('puuid')
        if not puuid and entry.get('summonerId'):
            puuid = api.puuid_from_summoner_id(entry['summonerId'])
        if not puuid or puuid in seen:
            return
        seen.add(puuid)
        rec = {'puuid': puuid, 'tier': tier, 'division': division, 'score': tier_score(tier, division)}
        seeds.append(rec)
        append_line(seeds_path, json.dumps(rec))

    for tier in args.tiers:
        if tier in APEX:
            for e in api.apex_entries(tier):
                add(e, tier, 'I')
            print('  seeded %s: %d players total' % (tier, len(seeds)))
            continue
        for div in args.divisions:
            for page in range(1, args.seed_pages + 1):
                entries = api.league_entries(tier, div, page)
                if not entries:
                    break
                for e in entries:
                    add(e, tier, div)
            print('  seeded %s %s: %d players total' % (tier, div, len(seeds)))
        if args.max_players and len(seeds) >= args.max_players * 3:
            break
    with open(done_marker, 'w') as f:
        f.write('ok')
    return seeds


# ----------------------------------------------------------------------------- main
def parse_limits(s):
    out = []
    for part in s.split(','):
        n, w = part.split('/')
        out.append((int(n), float(w)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--platform', default='euw1', choices=sorted(PLATFORM_TO_REGION))
    ap.add_argument('--tiers', default='EMERALD', help='comma list from IRON..DIAMOND, MASTER, GRANDMASTER, CHALLENGER')
    ap.add_argument('--divisions', default='IV,III,II,I')
    ap.add_argument('--seed-pages', type=int, default=3, help='league-v4 pages (~200 players each) per tier/division')
    ap.add_argument('--max-players', type=int, default=0, help='stop after this many players (0 = all seeds)')
    ap.add_argument('--matches-per-player', type=int, default=20)
    ap.add_argument('--max-matches', type=int, default=10000, help='stop when the output file has this many matches')
    ap.add_argument('--days', type=float, default=14, help='only matches from the last N days')
    ap.add_argument('--patch', help="keep only this patch, e.g. '14.18'")
    ap.add_argument('--out', default='matches.jsonl')
    ap.add_argument('--limits', default='20/1,100/120', help='"requests/seconds" pairs; dev key default')
    ap.add_argument('--safety', type=float, default=0.9, help='use this fraction of each limit')
    ap.add_argument('--seed', type=int, default=0, help='shuffle seed for the player order')
    ap.add_argument('--ddragon-version', help='force a Data Dragon version for the championId map')
    a = ap.parse_args()

    key = os.environ.get('RIOT_API_KEY')
    if not key:
        sys.exit('Set the RIOT_API_KEY environment variable (https://developer.riotgames.com).')
    a.tiers = [t.strip().upper() for t in a.tiers.split(',') if t.strip()]
    for t in a.tiers:
        if t not in TIERS and t not in APEX:
            sys.exit('Unknown tier %s' % t)
    a.divisions = [d.strip().upper() for d in a.divisions.split(',') if d.strip()]

    state_dir = a.out + '.state'
    os.makedirs(state_dir, exist_ok=True)
    champ_map = load_champion_map(state_dir, a.ddragon_version)
    api = Riot(key, a.platform, RateLimiter(parse_limits(a.limits), a.safety))

    seen_matches = set(read_lines(os.path.join(state_dir, 'seen_matches.txt')))
    n_out = 0
    if os.path.exists(a.out):
        for l in read_lines(a.out):
            try:
                seen_matches.add(json.loads(l)['match_id'])
                n_out += 1
            except (ValueError, KeyError):
                pass            # a half-written last line from an interrupted run is ignored
    done_players = set(read_lines(os.path.join(state_dir, 'done_players.txt')))
    print('Resuming: %d matches in %s, %d seen ids, %d players done' % (n_out, a.out, len(seen_matches), len(done_players)))

    try:
        seeds = seed_players(api, a, state_dir)
        random.Random(a.seed).shuffle(seeds)
        if a.max_players:
            seeds = seeds[:a.max_players]
        seed_info = {s['puuid']: (s['tier'], s['score']) for s in seeds}
        print('%d seed players' % len(seeds))
        start_time = time.time() - a.days * 86400
        stats = collections.Counter()
        t0 = time.time()
        for i, s in enumerate(seeds):
            if n_out >= a.max_matches:
                break
            if s['puuid'] in done_players:
                continue
            ids = api.match_ids(s['puuid'], start_time, None, min(100, a.matches_per_player))
            for mid in ids[:a.matches_per_player]:
                if n_out >= a.max_matches:
                    break
                if mid in seen_matches:
                    continue
                data = api.match(mid)
                seen_matches.add(mid)
                append_line(os.path.join(state_dir, 'seen_matches.txt'), mid)
                if data is None:
                    stats['fetch_failed'] += 1
                    continue
                rec, why = parse_match(data, champ_map, a.platform, seed_info)
                if rec is None:
                    stats['skip_' + why] += 1
                    continue
                if a.patch and rec['patch'] != a.patch:
                    stats['skip_patch'] += 1
                    continue
                append_line(a.out, json.dumps(rec))
                n_out += 1
            append_line(os.path.join(state_dir, 'done_players.txt'), s['puuid'])
            done_players.add(s['puuid'])
            if (i + 1) % 10 == 0:
                print('player %d/%d  matches %d  requests %d  %.0f req/min  skips %s' % (
                    i + 1, len(seeds), n_out, api.requests, api.requests / max((time.time() - t0) / 60, 1e-9), dict(stats)))
    except FatalApiError as e:
        sys.exit('FATAL: %s' % e)
    except KeyboardInterrupt:
        print('\nInterrupted - progress is saved; re-run the same command to continue.')
    print('Done: %d matches in %s' % (n_out, a.out))


if __name__ == '__main__':
    main()

// desktop-app/glossary.js
// One place for what every number means (B2) and where every panel's data comes from (B1). Renderer only.
//   DD.glossary                 { key: { title, group, html } }: the single set of definitions. Header tooltips, "?" chips and
//                               the Glossary dialog all read from here.
//   DD.glossaryHtml(key)        '<h4>title</h4>' + body, for the existing tooltip boxes
//   DD.help(key)                a small "?" chip; a click opens the definition (never triggers the element it sits in)
//   DD.ppClass(p)               the one evidence scale: 'pp-high' (>= 90%), 'pp-mid' (50-90%), 'pp-low' (< 50%)
//   DD.provChip(id, info)       a data-source chip; click for details and a refresh button. info: { title, source, short (chip
//                               label of the source), url, rank, period, games, updatedAt, fetchedAt, stale, note,
//                               rows:[[label, value]], onRefresh: async () => ({ message }) }
//   DD.openGlossary(key?)       the full Glossary dialog (Help), scrolled to `key`
(function () {
    'use strict';
    const DD = window.DD;
    if (!DD) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ------------------------------------------------------------------------------------------------ definitions
    const SCALE = '<p><b>Colours:</b> <span class="pp-high">≥90%</span> strong evidence it helps · <span class="pp-mid">50–90%</span> leaning positive but uncertain · <span class="pp-low">&lt;50%</span> more likely hurts than helps. The same scale is used everywhere in DravenGap.</p>';
    const G = {
        'exp-wr': { group: 'Draft', title: 'Exp WR: expected win rate', html: `
            <p>Your estimated chance to win if you pick this champion into the current draft: <b>meta strength</b> (the champion's shrunk base WR) plus the <b>draft effect</b> (Shrunk Δ from the current allies and enemies).</p>
            <p><b>Why log-odds:</b> the two are added on the log-odds scale, logit(Exp WR) = logit(Base WR) + logit(50% + Shrunk Δ). Near 50% this is just base + Δ, but it stays sensible at extreme win rates and never leaves 0-100%. Uncertainty from both parts is combined (assumed independent).</p>
            <p><b>Who it's for:</b> an average player at the selected rank. Your personal "You" column is <b>not</b> included.</p>
            <p class="pp-muted">The thin bar under each value is its 95% range (see "Uncertainty bar"). This stops a 46%-WR champion with a +2% Δ from outranking a 53% champion with +1%.</p>` },
        'uncertainty': { group: 'Draft', title: 'Uncertainty bar', html: `
            <p>The thin bar under an Exp WR shows how sure the estimate is. The track runs from 40% to 60%; the tick in the middle marks 50%.</p>
            <p>The coloured part covers the 95% range (the value ± 2 SD). A <b>short</b> bar means the number rests on plenty of games; a <b>long</b> bar means "could be good, but we don't really know". Its colour is the chance the true Exp WR is above 50%, on the usual scale.</p>
            ${SCALE}` },
        'pp-draft': { group: 'Draft', title: 'PP (draft): posterior probability', html: `
            <p>The probability that this pick's <b>true</b> combined Δ is above zero, i.e. that the draft really raises your win chance and the Total Δ isn't just sampling noise.</p>
            <p><b>How it's calculated:</b> each matchup/synergy Δ is treated as a noisy measurement whose noise depends on its game count. Every Δ is shrunk toward 0 using a prior learned from the dataset, with a separate prior for each relationship type (lane opponent, jungle interactions, bot/support duo, other enemies, other allies), so small samples shrink a lot and large samples barely move. The shrunk Δs are summed, the uncertainty is widened because the matchups share the same games and aren't fully independent (correlation correction), and P(true sum &gt; 0) is reported.</p>
            ${SCALE}
            <p class="pp-muted">PP says how <i>sure</i> we are, not how <i>big</i> the edge is. Read it next to Total Δ: a large Total Δ with a modest PP rests on few games. Only matchups meeting Min Games count. PP in the Builds view is a different quantity (see "PP (builds)").</p>
            <p><b>Does it hold up?</b> Checked on later games (October 2026, Platinum+ and Emerald+): pairings with PP of 90% or more, computed from the previous patches, were still about +1.1 points on average in the next patch (+1.1 to +1.2 predicted), and those under 50% about −0.5. How often the later result had the predicted sign matched what PP said, in every PP band. Synergies with allies kept about 85% of their predicted size, so read ally edges slightly more cautiously.</p>` },
        'shrunk-delta': { group: 'Draft', title: 'Shrunk Δ', html: `
            <p>The best estimate of this pick's <b>true</b> combined Δ. It is the sum of the matchup/synergy Δs after each one is pulled toward 0 according to how few games it rests on.</p>
            <p>A +6% Δ from 300 games is mostly noise and gets cut hard; a +2% Δ from 8,000 games barely changes. Priors differ by relationship type, so lane counters count for more and off-lane noise for less.</p>
            <p>Checked on the next patch's games: shrunk Δs kept about 95% of their size, raw Δs only about half. That is why the draft sorts by the shrunk numbers.</p>
            <p>With "Borrow strength from broader data" on, the pull is toward a broader dataset's estimate instead of 0 where one exists: the last 30 days for the current patch, and all/Platinum+/Emerald+ data for narrow rank brackets. That dataset has this one's games removed first, and how far the two can truly differ is measured from the data.</p>
            <p class="pp-muted">Hover a value for its 95% credible interval and the raw Total Δ.</p>` },
        'base-wr': { group: 'Draft', title: 'Base WR (shrunk)', html: `
            <p>The champion's overall win rate in this role, <b>pulled toward the role average</b> in proportion to how few games it rests on. A 35% WR from 1,000 games is mostly noise and gets pulled up a lot; a 52% WR from 500,000 games barely moves.</p>
            <p><b>How:</b> empirical Bayes per role. The spread of true win rates between champions (about 1.5 pts) is estimated from the data, then each champion's WR is blended with the role mean using its game count.</p>
            <p class="pp-muted">A dimmed value with * means the shrunk WR is still uncertain (SD above 0.8 pts, roughly under 2,700 games). The Min Base WR % filter and sorting use this shrunk value. ▲/▼ next to it is a patch trend (see "Patch trend").</p>` },
        'p-best': { group: 'Draft', title: 'P(best): chance of being the best pick', html: `
            <p>How often this champion has the highest <b>Exp WR</b> (not Shrunk Δ) among the available candidates, when each candidate's true Exp WR is simulated from its estimate and uncertainty (2,000 draws, fixed seed so numbers don't flicker). Picked and banned champions are excluded; the filters (Role Freq, Min Base WR) define the candidate set. Values sum to 100%.</p>
            <p><span class="pbest-tie">≈</span> <b>Statistical tie:</b> when nobody reaches 50% and two or more candidates have at least 10%, those candidates are marked ≈ because the data can't separate them.</p>
            <p class="pp-muted">Candidates are simulated as independent. Their errors actually share the same ally/enemy matchups, so the true race is somewhat tighter than shown.</p>` },
        'delta': { group: 'Draft', title: 'Delta 2, Total Δ, Lane / Ally / Enemy Δ', html: `
            <p><b>Delta 2</b> (LoLalytics) answers: <i>how much does picking A into B change the result, purely because of how their kits interact?</i> It already adjusts for both champions' overall win rates and the rank's average.</p>
            <p><b>What +3.26 means:</b> given how strong A and B are right now, A should beat B X% of the time; A actually beats B X + 3.26% of the time.</p>
            <p><b>Total Δ</b> is the raw sum over every ally and enemy that meets Min Games; <b>Lane Δ</b> is the lane opponent's part, <b>Ally Δ</b> and <b>Enemy Δ</b> the rest. Shrunk Δ is the honest version of Total Δ.</p>` },
        'role-freq': { group: 'Draft', title: 'Role Freq', html: `<p>How often the champion is played in this role when it is picked at all. A champion at 3% Role Freq in Top is mostly played elsewhere; its numbers in Top rest on few games.</p>` },
        'you': { group: 'Draft', title: 'You: personal offset', html: `
            <p>How much better or worse than average you do on this champion, in win-rate points, from your Summoner's Rift games (ranked and normals; not ARAM, Arena or co-op vs AI): the ones the League client shares, plus your Profile backfill when a Riot key is set.</p>
            <p><b>How it's calculated:</b> your win rate on the champion minus the dataset's base WR for it (per game, using the role you played), minus your overall level vs. the dataset's rank. The result is shrunk heavily toward 0 (prior SD 5%) according to how few games you have, so 3 games barely move it.</p>
            <p class="pp-muted">Shown separately: it is <b>not</b> included in Exp WR, Shrunk Δ, PP or P(best). Blank means no games on that champion in your saved history. The client only shares your recent games (roughly the last 20–100), so DravenGap saves them on every refresh and the history grows over time.</p>` },
        'blind-risk': { group: 'Draft', title: '⚠ Blind-pick risk', html: `
            <p>Shown only while your lane opponent is not picked yet. Over the champions usually played in that lane (each weighted by how often it is picked), the pick's lane effect is averaged, and the hardest likely counters are listed.</p>
            <p>⚠ appears when a counter picked in 3%+ of the lane's games costs 3+ points (after the same sample-size adjustment as Shrunk Δ).</p>` },
        'patch-trend': { group: 'Draft', title: 'Patch trend ▲ / ▼', html: `<p>The champion's shrunk base WR now against the previous saved patch (same rank). ▲ / ▼ appears only when the change is at least 0.75 points <b>and</b> at least twice its noise, so ordinary patch-to-patch wobble is not flagged. It costs no extra downloads.</p>` },
        'verdict': { group: 'Draft', title: 'Draft verdict (Draft Analysis)', html: `
            <p>The chance the left team wins with the current picks, using the same model as Exp WR: every champion's base strength plus half of every cross-team pairing and ally pair, all sample-size adjusted, on the log-odds scale.</p>
            <p>The head-to-head lanes weigh the most because lane matchups vary the most. A draft between 48% and 52% is <b>even</b>: small edges are within noise.</p>` },
        'tier': { group: 'Draft', title: 'Tier list tiers', html: `
            <p>A champion's tier is its <b>shrunk</b> win rate (small samples pulled toward the role average) against the average of its role, weighted by games: <b>S+</b> +2.5 points or more, <b>S</b> +1.5, <b>A</b> +0.5, <b>B</b> within ±0.5, <b>C</b> down to −1.5, <b>D</b> below.</p>
            <p>Niche picks (played in that role in under 10% of the champion's games, or picked in under 0.5% of games) are hidden unless you ask for them. ▲/▼ is a real change since the previous saved patch (see "Patch trend").</p>
            <p class="pp-muted">The tier list follows the Time Period and Rank selectors, like the draft.</p>` },
        'game-plan': { group: 'Draft', title: 'Game plan', html: `
            <p>The brief for your pick once champion select has it: your Exp WR in this draft, the lane matchup against your opponent (adjusted Δ, PP, games), the draft verdict, how you do on the champion (your history, and your record against this opponent from Profile), the best items against your opponent when that matchup's builds are loaded, counters to watch while the opponent is unknown, and composition warnings.</p>` },
        'ban-value': { group: 'Draft', title: 'Ban value (Bans tab)', html: `<p>Expected wins the enemy gains per 100 games if a champion is left open: its pick rate in a lane × its edge over 50% Exp WR against your current picks, summed over the enemy's open lanes. A rough guide: it assumes the enemy picks each champion as often as usual.</p>` },
        'duo': { group: 'Draft', title: 'Duo synergy', html: `
            <p>Pairs for you and your duo partner, ranked by the pair's <b>duo Exp WR</b>: both champions' base strength plus their adjusted synergy Δ (the same sample-size shrinkage as Shrunk Δ, using the duo prior for Bot + Support and the jungle prior for Jungle + a lane).</p>
            <p>PP is the chance the pair's synergy is truly positive, on the usual scale. "Together" is your record with the partner from the games saved in Profile.</p>
            ${SCALE}` },
        'wpa': { group: 'Builds', title: 'WPA: win probability added', html: `
            <p>How much the team's win chance moved, in percentage points, while the item (or rune, or spell) was in use. Coachless estimates the win chance at every moment of a game with a model trained on ranked games.</p>
            <p><b>Why not just win rate?</b> Win rate hides when the item gets bought. Heartsteel has the best win rate (54.2%) but is mostly bought by players who are already ahead (Pre-Buy WP 53.7%), so it gets credit it didn't earn. Titanic Hydra has the highest WPA (+1.46) because the win chance rose most while it was held.</p>
            <p class="pp-muted">Data: Coachless (coachless.gg) by xPetu, Emerald+ only, used with permission. Coachless WPA is its own model; it is not mixed with the draft deltas.</p>` },
        'pp-builds': { group: 'Builds', title: 'PP (builds): chance it really helps', html: `
            <p>The probability that a row's <b>true</b> WPA is above zero, i.e. that buying (or taking) it really raises your win chance and the WPA isn't just luck from a small sample.</p>
            <p>Each WPA is a noisy average: its uncertainty comes from the number of buys and the win chance at purchase. The WPA is pulled toward 0 the fewer buys it rests on, using how much WPAs really differ for that item type (measured from Coachless data). PP is the chance the result is above 0.</p>
            <p><b>Several patches pooled</b> (Last N patches, a patch range, or 30 days): a row's true WPA also moves between patches (item and champion changes), so more patches must not make it look more certain than it is. DravenGap measures how much the row's WPA differs from patch to patch (a random-effects estimate, tau<sub>b</sub>²) and adds it to the uncertainty: variance = sampling noise / buys + tau<sub>b</sub>² × Σ(buys per patch)² / (total buys)². Rows that agree across patches are unchanged; rows that swing lose PP. A single patch has no such term.</p>
            ${SCALE}` },
        'pre-buy': { group: 'Builds', title: 'Pre-Buy WP, Buys, Pick Rate', html: `
            <p><b>Pre-Buy WP</b>: the team's win chance at the moment the item was bought. High values mean it is bought when already ahead.</p>
            <p><b>Buys</b>: purchases (games for runes and spells). Rows under 1,000 are dimmed. <b>Pick Rate</b>: item rows are the share of all purchases in that table (rows add up to about 100%); rune and spell rows are the share of games. Rows under 1% are dimmed.</p>` },
        'coaching': { group: 'Builds', title: 'Your build vs the data', html: `
            <p>Compares the items you finish with in your own games on a champion (from the games saved in Profile) with the Coachless WPA tables for the same champion and role.</p>
            <p>A suggestion is shown only with strong evidence: the alternative must have <b>PP ≥ 90%</b>, a WPA at least 0.5 points above your item, and enough buys. Otherwise the card says your build is in line with the data.</p>` },
        'dd-score': { group: 'Profile', title: 'DD Score, MVP and ACE', html: `
            <p>An op.gg-style 0–10 performance score computed by DravenGap for all 10 players of a game (op.gg's exact formula isn't public).</p>
            <p>Nine parts, each relative to the game's average: KDA, kill participation, damage to champions, damage taken + mitigated, gold, CS/min and vision/min against what the role usually gets, objective damage and survival. They are weighted by role (carries: damage, gold, CS; junglers: kills and objectives; supports: vision, kill participation, tanking), a win adds a little, and the result is standardised within the game.</p>
            <p>The best player of a game lands near 9–10, a typical one around 5–6. <b>MVP</b> is the best player on the winning team, <b>ACE</b> the best on the losing team. Remakes and non-5v5 modes get no score.</p>` },
        'tags': { group: 'Profile', title: 'Live game tags', html: `
            <p><b>Hot streak / Loss streak</b>: 3+ wins (losses) in a row in the player's most recent games, or Riot's win-streak flag. <b>Veteran</b>: 100+ ranked solo games this season.</p>
            <p><b>First time</b>: no ranked games and no mastery on the champion. <b>New to champ</b>: at most 1 ranked game on it this season (op.gg) or under 10,000 mastery, unless they have 50,000+ mastery.</p>
            <p><b>One-trick</b>: 60%+ of 15+ ranked games this season on this champion (10+ games on it). <b>Autofill</b>: Smite but mostly another role (50%+ of games there, under 15% jungle), or a jungle main without Smite.</p>
            <p><b>Smurf?</b>: level 40 or lower with 55%+ over 10+ games, or 15–60 ranked games at 65%+. <b>Duo / Premade</b>: seen together in the client lobby, a shared recent match, or two shared cached matches.</p>` },
        'aram': { group: 'ARAM Mayhem', title: 'ARAM Mayhem numbers', html: `
            <p><b>WR / tier / vs avg</b>: the champion's ARAM: Mayhem win rate and tier from arammayhem.com, and its difference from the average champion.</p>
            <p><b>Augments</b>: win rate when the augment was taken and how often it appeared (rows under 2% are dimmed); "vs champ" is the difference from the champion's own Mayhem WR.</p>
            <p><b>Items</b> come only from LoLalytics <b>regular</b> ARAM (all ranks, 30 days), so their win rates are not comparable with Mayhem win rates.</p>
            <p><b>Reroll advice</b>: an average reroll is the mean Mayhem WR over all champions (a reroll is random); a bench swap is suggested when the bench has a champion 1+ point better.</p>` },
        'arena': { group: 'Arena', title: 'Arena numbers', html: `
            <p><b>Top-half rate</b>: how often the champion finished in the better half of the lobby (top 3 of 6 teams in today's 3-player format; top 4 of 8 in the older 2-player format). This is LoLalytics' "Win" for Arena. First place alone is much rarer.</p>
            <p><b>Top 4 / average place</b> (your Profile's Arena tab): the same idea for your own games. The "win" line is half the teams in that game, so 2v2 and 3v3 games count fairly.</p>
            <p><b>Augments and items</b>: top-half rate when taken, and how often. Later picks and items look better because only players who survive longer reach them, so each row is compared with its own group's average ("vs avg"). Small samples are pulled toward that average before sorting (counted fully after a few hundred games).</p>
            <p><b>Partners</b>: how a pair did together against what the two champions do apart ("vs apart"). The champion-select estimate is the two champions' average top-half rate plus that pair effect.</p>
            <p class="pp-muted">Source: lolalytics.com (Arena tier list and build pages), fetched when you open the view or a champion, cached for about 6 hours. Augment icons: CommunityDragon.</p>` },
        'sources': { group: 'Data', title: 'Data sources and freshness', html: `
            <p><b>LoLalytics</b> (draft: champion stats, matchups and synergies): the current patch and 30 days come from DravenGap's data bucket; past patches and 7/14-day windows are downloaded on this PC. Emerald+ refreshes itself automatically; other ranks download when you ask.</p>
            <p><b>Coachless</b> (Builds: WPA for items, runes and spells, Emerald+): fetched on demand per champion and role, never in bulk.</p>
            <p><b>arammayhem.com</b> (Mayhem tier list and augments) and <b>LoLalytics ARAM</b> (ARAM items): cached for about 6 hours. <b>LoLalytics Arena</b> (Arena tier list and builds): the same.</p>
            <p><b>Riot API</b> (Profile, live game; needs your key) and <b>op.gg</b> (past seasons, champion stats in live games): cached and rate-limited.</p>
            <p class="pp-muted">Every panel has a chip such as "Emerald+ · Patch 16.19 · 1.2M games · 2 h ago". Click it for the details and a refresh button.</p>` },
        'colours': { group: 'Data', title: 'Colours', html: `
            ${SCALE}
            <p>Green / red values (Δ, Exp WR, WPA) are simply above / below the neutral point (0, or 50%). In Profile, blue and red rows are wins and losses.</p>` }
    };
    DD.glossary = G;
    DD.glossaryHtml = key => { const e = G[key]; return e ? `<h4>${e.title}</h4>${e.html}` : ''; };
    DD.ppClass = p => (p == null || !isFinite(p) ? '' : p >= 0.9 ? 'pp-high' : p >= 0.5 ? 'pp-mid' : 'pp-low');
    DD.help = (key, extraClass) => {
        const e = G[key];
        return e ? `<button type="button" class="dg-help${extraClass ? ' ' + extraClass : ''}" data-term="${esc(key)}" title="What is this? (${esc(e.title)})" aria-label="Explain ${esc(e.title)}">?</button>` : '';
    };

    // ------------------------------------------------------------------------------------------------ popover
    const pop = document.createElement('div');
    pop.className = 'dg-pop';
    pop.setAttribute('role', 'dialog');
    pop.style.display = 'none';
    document.body.appendChild(pop);
    let popAnchor = null;
    function showPop(anchor, html) {
        popAnchor = anchor;
        pop.innerHTML = `<button type="button" class="dg-pop-x" aria-label="Close">&times;</button>${html}`;
        pop.style.display = 'block';
        const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
        let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }
    function hidePop() { pop.style.display = 'none'; popAnchor = null; }
    DD.hidePopover = hidePop;

    // ------------------------------------------------------------------------------------------------ data-source chips
    const prov = new Map();   // id -> info (latest render wins)
    const fmtGames = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
    function ago(ts) {
        if (!ts) return '';
        const s = (Date.now() - ts) / 1000;
        if (s < 60) return 'just now';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        if (s < 86400 * 2) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' d ago';
    }
    DD.ago = ago;
    DD.fmtGames = fmtGames;
    const toTs = v => (v == null ? null : typeof v === 'number' ? v : (t => (isNaN(t) ? null : t))(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || !/T/.test(v) ? v : v + 'Z')));
    DD.provChip = (id, info) => {
        if (!info) return '';
        prov.set(id, info);
        const when = toTs(info.updatedAt) || toTs(info.fetchedAt);
        const parts = [info.rank, info.period, info.games ? fmtGames(info.games) + ' games' : null, when ? ago(when) : null, info.short || info.source].filter(Boolean);
        const stale = info.stale ? ' stale' : '';
        return `<button type="button" class="dg-prov${stale}" data-prov="${esc(id)}" title="Where this data comes from (click for details)"><span class="dg-prov-dot"></span>${esc(parts.join(' · '))}</button>`;
    };
    function provHtml(info) {
        const rows = [];
        if (info.source) rows.push(['Source', info.url ? `<a href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.source)}</a>` : esc(info.source)]);
        if (info.rank) rows.push(['Rank', esc(info.rank)]);
        if (info.period) rows.push(['Period', esc(info.period)]);
        if (info.games) rows.push(['Games', Math.round(info.games).toLocaleString('en-US')]);
        for (const [k, v] of info.rows || []) rows.push([esc(k), esc(v)]);
        const up = toTs(info.updatedAt), fe = toTs(info.fetchedAt);
        if (up) rows.push(['Data from', `${new Date(up).toLocaleString()} (${ago(up)})`]);
        if (fe && fe !== up) rows.push(['Fetched', `${new Date(fe).toLocaleString()} (${ago(fe)})`]);
        return `<h4>${esc(info.title || 'Data source')}</h4><table class="dg-prov-t">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
            ${info.note ? `<p class="pp-muted">${esc(info.note)}</p>` : ''}
            <div class="dg-pop-actions">${info.onRefresh ? '<button type="button" data-prov-refresh>Refresh now</button>' : ''}<button type="button" data-gloss="sources">About the sources</button></div>
            <div class="dg-pop-msg"></div>`;
    }

    // ------------------------------------------------------------------------------------------------ glossary dialog
    const modal = document.createElement('div');
    modal.id = 'glossary-modal';
    modal.style.display = 'none';
    modal.innerHTML = `<div class="modal-content dg-gloss"><button class="modal-close-btn" aria-label="Close glossary">&times;</button>
        <h2>Glossary</h2><input type="search" class="dg-gloss-q" placeholder="Search terms…" aria-label="Search the glossary"><div class="dg-gloss-body"></div></div>`;
    document.body.appendChild(modal);
    const body = modal.querySelector('.dg-gloss-body'), q = modal.querySelector('.dg-gloss-q');
    function renderGloss() {
        const n = q.value.trim().toLowerCase();
        const groups = {};
        for (const [k, e] of Object.entries(G)) {
            if (n && !(e.title + ' ' + e.html.replace(/<[^>]+>/g, ' ')).toLowerCase().includes(n)) continue;
            (groups[e.group] = groups[e.group] || []).push([k, e]);
        }
        body.innerHTML = Object.entries(groups).map(([g, list]) => `<h3>${esc(g)}</h3>` + list.map(([k, e]) => `<details id="gloss-${k}" data-key="${k}"><summary>${e.title}</summary>${e.html}</details>`).join('')).join('') || '<p>No term matches.</p>';
    }
    DD.openGlossary = key => {
        hidePop();
        q.value = '';
        renderGloss();
        modal.style.display = 'flex';
        const d = key && body.querySelector(`#gloss-${CSS.escape(key)}`);
        if (d) { d.open = true; setTimeout(() => d.scrollIntoView({ block: 'start' }), 0); } else q.focus();
    };
    const closeGloss = () => { modal.style.display = 'none'; };
    q.addEventListener('input', renderGloss);
    modal.querySelector('.modal-close-btn').addEventListener('click', closeGloss);
    modal.addEventListener('click', e => { if (e.target === modal) closeGloss(); });

    // ------------------------------------------------------------------------------------------------ events
    // Capture phase: a "?" or a chip inside a sortable header / clickable row must not also sort or select.
    window.addEventListener('click', e => {
        const h = e.target.closest && e.target.closest('.dg-help');
        const c = !h && e.target.closest && e.target.closest('.dg-prov');
        if (!h && !c) return;
        e.stopPropagation(); e.preventDefault();
        const el = h || c;
        if (popAnchor === el && pop.style.display !== 'none') { hidePop(); return; }
        if (h) showPop(h, DD.glossaryHtml(h.dataset.term) + `<div class="dg-pop-actions"><button type="button" data-gloss="${esc(h.dataset.term)}">Open the glossary</button></div>`);
        else { const info = prov.get(c.dataset.prov); if (info) { showPop(c, provHtml(info)); pop.dataset.prov = c.dataset.prov; } }
    }, true);
    pop.addEventListener('click', async e => {
        if (e.target.closest('.dg-pop-x')) { hidePop(); return; }
        const g = e.target.closest('[data-gloss]');
        if (g) { DD.openGlossary(g.dataset.gloss); return; }
        const r = e.target.closest('[data-prov-refresh]');
        if (r) {
            const info = prov.get(pop.dataset.prov);
            const msg = pop.querySelector('.dg-pop-msg');
            if (!info || !info.onRefresh) return;
            r.disabled = true; msg.textContent = 'Refreshing…';
            try { const out = await info.onRefresh(); msg.textContent = (out && out.message) || 'Done.'; }
            catch (err) { msg.textContent = 'Could not refresh: ' + (err && err.message || err); }
            r.disabled = false;
        }
    });
    document.addEventListener('mousedown', e => { if (pop.style.display !== 'none' && !pop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) hidePop(); });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (pop.style.display !== 'none') { hidePop(); e.stopPropagation(); }
        else if (modal.style.display !== 'none') closeGloss();
    });
    window.addEventListener('resize', hidePop);
    DD.onView && DD.onView(hidePop);
})();

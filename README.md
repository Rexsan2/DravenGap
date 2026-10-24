# DravenGap

A League of Legends companion for Windows: draft recommendations with honest statistics, builds, profiles and live game scouting, in one desktop app that follows your League client.

DravenGap is a fork of [DraftDiff / DeltaDraft](https://github.com/Lydig/deltadraft) by **Lydig**. The draft model, the LoLalytics dataset it reads and the original app are his work; all credit for them goes to him.

## How it differs from DraftDiff

**Draft**
- Exp WR (expected win rate of the whole draft), P(best), Pick Power and adjusted matchup / synergy deltas that pull small samples toward the average, with uncertainty bars and a "why" panel for every recommendation.
- Champion select shown in pick order: your team placed by each player's assigned lane, the enemy guessed from role play rates (drag to correct).
- Adaptive time period, checked against the next patch: matchups and synergies pool every saved patch of the season (they barely drift, so this halves their error vs the current patch alone); champion win rates are weighted by measured meta drift, with buffs / nerfs from Riot's patch notes corrected for instead of cutting the data off.
- Buff / nerf / adjust marks (green ▲, red ▼, blue =) on champions changed this patch, with the changes on hover.
- "For you": Exp WR adjusted for your record on each champion (and how new you are to it), with a Best-for-you card in the draft and the mini window.
- Matchup pages (champion vs champion: lane effect, your record, the build against it, your notes shown in the game plan).
- Bans, blind-pick risk, Duo synergy, "what if" drafts, composition warnings, saved past patches and patch ranges.

**One workflow from lobby to review**
- Game flow bar following the client (Lobby › Champion select › In game › Review) with the next useful action at each step.
- Game plan after lock-in: lane matchup, your record on the champion and against your opponent, best items against them.
- One click (or automatic on lock-in) sends rune page, summoner spells and item set to the client.
- Back / forward between views, a right-click champion menu everywhere, Ctrl+K command palette.

**Builds and champions**
- Builds ranked by win probability added (Coachless data, on demand), matchup builds, skill order, build coaching on your own games.
- Champion pages, Summoner's Rift tier list with patch movers.
- ARAM Mayhem (champion options, augments from arammayhem.com in its recommended order with each augment's tier, ARAM builds) and Arena.

**Premades and replays**
- Premades: your record with the players you queue with, your best and never-tried champion pairs, and pairs beating or missing the stats. Click any pair for its details: both champions' numbers, synergy each way, your record with it, lane matchups and the best third champion. Tick up to 4 friends for a 2-5 stack planner. It shows roles (changeable), your record with all of them together, the best champion combos from everyone's pool, and each player's best picks for that stack.
- Replay review (Profile › a game › Review): a large map of your deaths and kills (hover for who and when, click to watch it), and buttons that jump the client's replay to 15 seconds before each death.
- Patch day: what a new patch did to your champions, once per patch.

**Profiles (op.gg-style)**
- Ranked, match history, DD Score per game, seasons, live game scouting with tags, multi-search from the lobby chat.
- Insights: form, strengths and areas to improve against your lane opponents, learning curve per champion, LP history read from the client, today's session.

**Under the hood**
- Runs in the tray (and can start with Windows); your own profile works from the League client without a Riot key.
- Works offline from saved data; test suite of 47 files (`npm test`) running the real window against local stub servers.

## Run from source

```bash
cd desktop-app
npm install
npm start        # run
npm test         # tests (about 3 minutes)
npm run dist     # installer in desktop-app/dist/
```

Profile lookups, multi-search and live game scouting use the Riot API: add your own key in Settings (source builds). Everything else works with just the League client.

## Data sources

Draft statistics: the public DraftDiff dataset (LoLalytics, refreshed by Lydig's pipeline). Builds: Coachless (on demand). ARAM Mayhem: arammayhem.com and LoLalytics. Profiles: Riot API and the League client. Champion data: Riot Data Dragon.

DravenGap isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

# DravenGap

A League of Legends companion for Windows: draft recommendations with honest statistics, builds, profiles and live game scouting, in one desktop app that follows your League client.

DravenGap is a fork of [DraftDiff / DeltaDraft](https://github.com/Lydig/deltadraft) by **Lydig**. The draft model, the LoLalytics dataset it reads and the original app are his work; all credit for them goes to him.

## How it differs from DraftDiff

**Draft**
- Exp WR (expected win rate of the whole draft), P(best), Pick Power and adjusted matchup / synergy deltas that pull small samples toward the average, with uncertainty bars and a "why" panel for every recommendation.
- Champion select shown in pick order: your team placed by each player's assigned lane, the enemy guessed from role play rates (drag to correct).
- Bans, blind-pick risk, Duo synergy, "what if" drafts, composition warnings, saved past patches and patch ranges.

**One workflow from lobby to review**
- Game flow bar following the client (Lobby › Champion select › In game › Review) with the next useful action at each step.
- Game plan after lock-in: lane matchup, your record on the champion and against your opponent, best items against them.
- One click (or automatic on lock-in) sends rune page, summoner spells and item set to the client.
- Back / forward between views, a right-click champion menu everywhere, Ctrl+K command palette.

**Builds and champions**
- Builds ranked by win probability added (Coachless data, on demand), matchup builds, skill order, build coaching on your own games.
- Champion pages, Summoner's Rift tier list with patch movers.
- ARAM Mayhem (champion options, augments from arammayhem.com, ARAM builds) and Arena.

**Profiles (op.gg-style)**
- Ranked, match history, DD Score per game, seasons, live game scouting with tags, multi-search from the lobby chat.
- Insights: form, strengths and areas to improve against your lane opponents, learning curve per champion, LP history read from the client, today's session.

**Under the hood**
- Works offline from saved data; test suite of 45 files (`npm test`) running the real window against local stub servers.

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

# Changelog

## 1.1.0 (2026-11-01)

A full review of the desktop app found 153 issues; after merging duplicates and an independent verification pass, 131 were confirmed and **all 131 are fixed** in this release. Every fix has a test: the suite grew from 51 to 71 test files, all passing.

Severity: **high** = wrong data, data loss, a crash or an unusable feature; **medium** = wrong in a common case or needs a workaround; **low** = cosmetic or rare.

### Also new
- Champion boxes complete names inline as you type ("qi" → Qiyana, "fate" → Twisted Fate); Enter, the dropdown or leaving the box takes an exact name ("Vi").
- Win rate by game length follows the selected Time Period and Rank, with 95% ranges on the champion page and the Profile.

### Upgrade notes
- Settings, favorites and history are now written atomically. A settings file that cannot be read is kept as `settings.json.corrupt-<time>` instead of being overwritten.
- The saved-data database (IndexedDB `draftdiff-datasets`) moves to version 4 on first start; older versions of the app cannot open it afterwards and will download data again.
- The app keeps its timers running while it sits in the tray, so automatic rune import stays on time (a small CPU cost).

### Draft and Live Tracking

**High**

- Champions you don't own are dropped from Bans, enemy/teammate suggestions and Duo partner picks

**Medium**

- A manual swap, grid placement or right-click clear during Live Tracking forgets the bans
- After Reset Draft / Practice draft the previous slot's recommendations come back
- Role locks (🔒) from one champion select carry into the next game
- Duo and Bans tabs stop following the draft and ignore Rank / Time Period / Min Games changes
- Recommendations, Draft Analysis and tooltips show Data Dragon ids; search can't find "Wukong"
- A teammate's (and your own) in-turn hover is shown and counted as a locked pick

**Low**

- Opening the champion grid (▼) deselects the slot you just clicked
- Selecting your own slot (yellow "you" outline) for a swap shows no change
- Hover swaps in blind pick / customs vanish once a teammate locks a champion
- "Back to pinned" leaves picked/available marks from the changed draft
- "Best for you" card: clicking the outside-your-pool pick does nothing when My pool is on
- "Best for you" card and For you column appear for enemy slots
- The grid lets the same champion be placed twice (or a banned one placed)
- Pool planner keeps "Your pool is not known yet" (or an old pool) for the whole session
- Draft help texts name a 💡 button and a "You" column that don't exist
- Overlapping Live Tracking polls can paint an older champion-select state
- Reset Draft during champion select leaves the board empty and Draft Analysis on the empty board

### Statistics, time periods and data downloads

**Medium**

- Download more history: the last dataset is counted after the run finished (0 saved, no toast, TypeError)
- A finished download (even the automatic one) reloads the shown dataset behind the full-screen overlay
- "Patch range…" Apply does not update the Tier list, Champion page, Premades or Builds
- A patch downloaded before the shared data has it can never be selected
- Every archive refresh reads every saved snapshot's matchup arrays (hundreds of MB to GBs)
- Adaptive ignores balance changes and reworks in patches missing from the archive

**Low**

- Reference prior never arrives for a second selection that shares the same reference ("Refining…" stuck)
- A partly failed LoLalytics scrape is saved as the whole patch and replaces good data for good
- "1 hours ago", "1 days ago" in the data header and Saved data
- Setup card shows the saved data's age shifted by the time zone
- Header says "Current patch updated …" for a patch range that doesn't contain the current patch
- Raw period / rank ids in user-facing text ("Last 30 Days / emerald_plus", "patch/platinum_plus")
- Why panel counts the slot's own champion as a pairing "below Min Games"
- "Clear downloaded rolling-window data" also deletes the 7/14-day downloads and leaves them listed
- Role frequencies (Live Tracking role guesses, Builds default role) follow the last foreground load, not the selected dataset
- Offline start after a new patch's metadata was saved shows no data and loses the "Offline" note
- "Refresh now" on a downloaded window of another rank does nothing

### Builds and Send to client

**High**

- Champion boxes complete to the wrong champion while you type (hub search, Builds box, ARAM add-by-hand)

**Medium**

- "Send to client" with a vs matchup sends the all-games spells and item set, not the ones shown
- One failed detail download leaves "Loading this table..." stuck for every champion
- A failed matchup (vs) download stays failed for the whole session
- Champion page Builds tab and coaching card ignore Time Period changes and label patches with " + "
- "Set spells" for junglers can drop Flash

**Low**

- Skill order and game-length errors are cached until restart
- Builds fetched during a patch are never refreshed after it ends, and detail tables never refresh at all
- The Coachless rate-limit note never updates when the wait is over and has no button
- Send to client messages go stale, lose the Replace button, or land in another champion's bar
- lcu-apply reports any create failure as "no free rune page", and Replace loops on a preset page
- DD.sendAll ignores the 3-patch auto-fetch cap and fails while another download runs
- Build coaching uses its own owner lookup and stays hidden when the client is closed
- An IndexedDB save error leaves the download state stuck for the session
- Possible unhandled promise rejection in the parallel overview fetch (main process) *(hardening; needs a real-client check)*

### Profile

**Medium**

- Your new game never shows on your profile while a queue tab other than All is open
- "Review the game" and Follow my game open whoever's profile is on screen, not yours
- "Refreshing..." never clears when the background profile refresh fails
- Insights stuck on "Crunching your games…" after changing the queue while loading
- With the League client closed, your own profile loses Goals, LP history and "your account"
- "Load season history" fails silently (expired key, no key, timeout)
- Live game "Retry" reloads the whole profile and jumps to Summary
- Replay "Watch from" stops working once a replay was opened (sticky running)
- Follow my game's end-of-game switch misses games that pass through WaitingForStats

**Low**

- Typed text in "Filter by champion" (and goal inputs) is wiped by background repaints
- A failed first match load leaves "Champions this season" on "Loading..." for good
- Region falls back to EUW1 instead of the client's region (Ctrl+K lookups, multi-search box, Settings account)
- Live game clock keeps running after the game ended
- Returning to the Profile view resets your match list to page 1
- Live tab says "Not in game" when the League client is not running
- The previous profile's match-list error and note carry over to the next profile
- "No account yet" page has a Retry button that does nothing
- Other players' profiles say "Your last game", "Your lane", "you died to"
- LP history shows apex ranks as "Master I"
- Patch lists in Review and Draft model check are comma lists (and the check hides the newest)
- Client-recorded games (ARAM Mayhem): Build / Analysis / Review ask Riot for a timeline that does not exist
- Main: client-recorded games can fall between two match-list pages (LCU merge window)

### Profile data and Riot API

**Medium**

- Without a key, the client-history import overwrites cached Riot matches, and the poorer copy stays after the key is back
- Adding a Riot key after using the app keyless: client-recorded games vanish and up to 100 Riot games keep no lane
- "Clear" on Profile look-ups (Settings > Diagnostics) also deletes the LP history

**Low**

- ARAM Mayhem game is lost when the client's region can't be read right after the game
- Switching to a key from another Riot project orphans the season ledger; recovery merges in only one path
- profile-cache/meta.json grows without bound and is rewritten whole, synchronously, on the main process
- "Load season history" keeps downloading last season's games past the season boundary
- ARAM Mayhem tab asks Riot for queue 2400 on every open and shows the key or offline error instead of the client games
- Post-game refresh stops silently when the key is rejected
- A profile looked up for the first time shows "Unranked" when only the league request fails
- Auto-refresh stops once the game's id is listed, even if its match file couldn't be downloaded yet
- LCU credential lookups are not de-duplicated and have no timeout; one hung spawn stops every phase event
- A Mayhem game ending cancels the still-running Riot refresh of the previous ranked game
- LCU region codes like LA1 / LA2 / OC1 have no mapping, so the region is never detected *(hardening; needs a real-client check)*

### App shell, navigation, tray and notifications

**High**

- Settings / favorites / personal history: one corrupt read wipes every saved key

**Medium**

- Replay state is read once: "checking" / "downloading" / unknown answers stick for the session
- In the tray, renderer timers are throttled: auto-send on lock-in can fire a minute late or not at all *(hardening; needs a real-client check)*
- Dropping a file on the window replaces the whole app (will-navigate allows any file:// URL) *(hardening; needs a real-client check)*
- Window opens off-screen after the monitor it was on is unplugged *(hardening; needs a real-client check)*

**Low**

- Windows notification click does nothing useful (no action, hidden window not shown)
- Patch-day card: clicking a champion picture navigates under the card, which stays up; shortcuts fire under it
- "Start with Windows" opens un-maximized and then forgets the maximized state
- Draft shortcuts stop working after clicking any checkbox or slider
- Saved game mode restore can override Follow my game at startup
- Mini window "open DravenGap" / row click does not bring back a main window hidden in the tray
- "Copy as image" can include the previous "Copied…" toast in the picture

### ARAM Mayhem, Arena and patch notes

**High**

- Arena: changing Ranks with a champion open crashes the view; a slow response can also paint the wrong bracket

**Low**

- Patch notes: leading-dot decimals and "0-9" ranges give the wrong buff/nerf
- ARAM/Arena: "refreshing" never ends, and Refresh says "fetched again" on failure
- ARAM reroll advice flips from "reroll" to "keep" as soon as the bench opens
- ARAM: unknown rerolls with a bench shown as "no rerolls left"
- ARAM: champions added by hand stay in every later champion select
- ARAM/Arena: tab choice sticks; later champion selects open on the tier list
- ARAM: failed LoLalytics items have no Retry, and re-selecting doesn't retry
- ARAM: one failed Data Dragon item.json leaves all items as "#id" until restart
- ARAM Full tier list: the "+" that the text mentions doesn't exist
- Arena: "2.9M games" and "picked in X% of games" use LoLalytics' scaled counts
- ARAM/Arena: in-game champion lost after switching League accounts
- ARAM prefetch keeps hitting arammayhem.com after a 429
- Champion page ARAM tab can throw when the LoLalytics core build has no win rate
- Glossary still calls the Profile's Arena number "Top 4"
- Arena: hovering during your pick turn counts as locked; pick intent ignored *(hardening; needs a real-client check)*
- ARAM/Arena: one empty poll undoes the user's manual champion choice *(hardening; needs a real-client check)*
- App started during ARAM/Arena champion select: flow bar shows SR draft actions *(hardening; needs a real-client check)*

### Premades, Duo, champion pages, tier list and glossary

**Medium**

- Premades "Most played together": a click opens the wrong combo or "undefined + undefined"
- Premades/Duo: games with a friend from before their Riot ID change are dropped
- Premades, Duo partners and My stats never refresh after new games are saved

**Low**

- Premades: a Time Period/Rank change can leave the previous period's numbers on screen
- Pool planner result can overwrite the tier list after a tab switch
- Tier list "Patch movers" asks to download a patch that is already saved
- Premades "Last N patches": your own games from unsaved patches are left out
- Duo tab stuck on "Ranking pairs…" when the draft dataset could not load
- Pool planner says "your other champions add less than 0.05 pts" when the 3-cap stopped it
- Matchup page: clicking a header picture changes the lane
- Champion page restore reopens the role it was opened with, not the role last viewed
- Tier list search box loses focus when the list reloads
- Glossary "Duo synergy" names a jungle prior that the model does not use
- Escape closes the Premades detail panel along with a "?" popover
- Riot ID parsers reject non-ASCII taglines *(hardening; needs a real-client check)*

## 1.0.0 (2026-10-12)

First DravenGap release, a fork of [DraftDiff / DeltaDraft](https://github.com/Lydig/deltadraft) by Lydig.

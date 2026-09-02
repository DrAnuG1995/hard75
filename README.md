# 75 Hard Ledger

A single-file tracker for a 75 Hard attempt, plus the meal plan that goes with
it. No build step, no dependencies, no server, no database, no account.

- **`index.html`** — the whole app. Open it and it runs.
- **`meal-plan.md`** — macros, recipes, cook schedule, shopping lists.
- **`test/`** — a browser harness that drives the real page. Dev-only; see
  [Testing](#testing).

## Running it

Open `index.html` in any browser — from disk, or over a local server:

```bash
python3 -m http.server 4173   # then http://localhost:4173
```

On a phone: open it, then **Share → Add to Home Screen**. It behaves like an app
from there.

### Publishing it

The file is self-contained with no external requests, so any static host works.
This repo is public, so GitHub Pages is free: Settings → Pages → deploy from
branch `main`, root. The page then lives at
`https://dranug1995.github.io/hard75/`.

Publishing the page publishes no data — the logging lives in the browser of
whoever opens it, so a hosted copy starts empty for everyone including you.

## Where the data lives

| What | Where |
|---|---|
| Days, water, workouts, reading, notes, weights, past attempts | `localStorage`, key `hard75.v1` |

That's the whole store, and it's **per-browser and per-device**. Nothing syncs.
Nothing is uploaded. There is no backend to leak.

This has one sharp edge: clearing site data wipes the streak. So —

- **Export weekly.** Setup → Export writes a small JSON file with every day,
  note, book and weight. Import replaces everything from that file.
- The app nags you if it's been 7 days since the last export, and the calendar
  file adds a weekly backup reminder. A cancelled or failed download doesn't
  count as a backup — the nag only clears once the file actually saves.
- The export is everything. The app stores nothing outside that one key.

Reading the meal plan and shopping lists works identically on every device,
since that content is baked into the page. Only the logging is per-device — so
track on the phone, shop from a desktop.

Importing a backup clears the "Pretend today is" override, so a file exported
mid-test can't strand the device it's restored onto.

## The rules it enforces

A day only counts when all seven are true:

1. No alcohol
2. Stuck to the diet
3. No cheat meals
4. 4 L of water (8 × 500 ml)
5. Two workouts of 45+ minutes, **at least one outdoors**. Both sessions start
   marked indoors — outdoors is something you tap to claim, never the state you
   land in by not touching anything.
6. 10 pages read — logged as a book title plus start and finish page, so the
   count is derived rather than self-declared. The next day inherits the book
   and starts at the page you stopped on. Starting a new book reads as a
   negative span, so the app says so rather than silently scoring zero.
7. Progress photo taken — the app doesn't hold the image. Take it with your
   camera and tick the box; the photos stay in your camera roll where you can
   actually flip through them, and this stays a page with no image store in it.

Four of the seven are enforced from real numbers rather than a checkbox: water,
workout minutes, the outdoors requirement, and pages read.

Miss any one and "I missed something today" archives the run and restarts the
count at day 1 tomorrow. There's a 12-second undo on the reset in case of a
misclick. Failed attempts keep their full day records — Stats shows how far each
one got and how many of those days were clean, and the weights and notes stay in
the export.

Any day in the **last 7 days** can be edited. That window started at today and
yesterday only, on the grounds that a streak you can back-fill a week later
isn't a streak — it was widened deliberately, and the trade is that a day can
now be completed from memory rather than as it happened. `EDIT_WINDOW` in
`index.html` is the one number to change if you want it tighter again.

Editing a past day is a temporary mode with a banner saying how far back you
are and a way out. It never changes what the app thinks the date is, and a
reload always lands you on today.

## Reminders

Setup → Download calendar file produces an `.ics` containing:

- 75 morning check-ins and 75 evening log reminders, at your chosen times
- The Sunday and Wednesday cook sessions, 11 weeks each
- A weekly backup nudge
- An all-day event on day 75

Import it into your phone calendar once. Times are written as *floating* local
time — no timezone, no DST drift, so a 6 am reminder stays at 6 am. Re-download
and re-import if you change the start date.

## The meal plan

2,000 kcal a day across five ~390 kcal meals, ~183 g protein, fat held near
44 g. A partner eats three of the same meals (~1,250 kcal) from the same cook,
so nothing is made twice. Eight mains, chicken and beef only, on two rotations
that alternate weekly. Two cook sessions: Sunday (18 servings) and Wednesday
(24). Breakfast runs two ways — a cooked hash from the batch or a no-cook dairy
bowl — which cuts about a third of the cooking.

Full detail, including per-serving amounts and four shopping lists, is in
`meal-plan.md`. The app carries the same data and can copy any shopping list to
the clipboard for an online grocery order.

From the day before a cook onwards, the Meals tab switches to the batch you're
about to make — recipes and the matching shopping list — rather than the one
you're currently eating out of. The rotation is anchored to the calendar week,
so a restart that lands day 1 mid-week still keeps each cook on the same
rotation as the days it feeds.

## Testing

Setup → "Pretend today is" overrides the current date so you can jump to day 40
or day 75 and check the counters, the calendar and the rotation logic without
waiting. Clear the field to go back to the real date.

### The check harness

There is nothing to unit-test — the app is one file with no exports — so
`test/check.mjs` drives the real page in headless Chromium and asserts on what
it actually does. It serves the repo itself on a spare port, because
`localStorage` and downloads behave differently over `file://`.

```bash
cd test && npm install && npx playwright install chromium && npm test
```

48 checks, exit 1 on any failure. Among them: a day won't close on 3.5 L of
water, two indoor workouts, a 44-minute session or 9 pages; the fail flow
archives and the undo restores; export → clear site data → import round-trips;
the `.ics` carries 75 daily repeats in floating local time and folds to 75
octets; the dark theme paints its own background; the page makes no external
request and grows no `<!doctype>`; and the Meals tab shows the list for the
cook you're about to do rather than the one you've eaten.

The app itself still has **no dependencies and no build step** — `test/` is the
only thing here that installs anything, and `index.html` never touches it.

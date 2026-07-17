# Observer lists + nicknames — 2026-07-17

Let users keep named SETS of observers, filter by them, and give observers nicknames.

## Data (GeoState)
- `observerLists` = [{ name, observers: [rawName,…] }]
- `observerNicks` = { rawName: nickname }

## Pieces
- [x] Storage helpers: get/save ObserverLists, get/save ObserverNicks, observerLabel(name)=nick||name, allKnownObservers() = union(detAllObservers + list members).
- [x] Filter panel (detObsPanelHtml): a row of saved-list chips (tap → set the observer filter to that list) + an "Lists ✎" button (opens editor). Observer checkbox rows show observerLabel (nickname).
- [x] Editor modal (openObserverEditor): New list; per list rename + delete + member chips (× remove) + add-observer <select>; a Nicknames section (input per known observer).
- [x] Wiring in the legend: list-chip → setDetObsFilter(new Set(list.observers)); edit → openObserverEditor.
- [x] i18n (en+sv) + CSS.

## Notes
- Nicknames shown in the filter panel + editor for this pass (where observers are selected); broader displays (balloon/detlist) can follow.
- Filtering by a list just sets the name Set; observers not currently plotted simply don't match.

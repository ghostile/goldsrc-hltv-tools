# Concussion estimate

The Conc tab and upper-left on-screen card estimate exposure to recorded `events/explode/tf_concuss.sc` explosions. They do not claim that a Concuss status was received, reconstruct view wobble, or score cheating.

Stock defaults are **280 game units**, **7 seconds for Medic (class 5)** and **15 seconds for every other known class**. Controls allow adjustments for modified servers. Each new exposure restarts the timer. The card follows the main POV where available, otherwise the selected player. Purple timeline bands and the Conc event list follow the selected player. These are live viewer overlays, not video-export overlays.

## Timing evidence

Read-only disassembly of the user's installed `tfc/dlls/tfc.so`, SHA256 `5dc18ac2014f178ad5cdf38fe53bdc473347c3319b11d748f38046601a414cbb`, on 2026-11-14:

- `CBasePlayer::TeamFortress_Concuss(entvars_s*)`, address `0xb98d0`: stores the current time at player offset `0xa50`, duration float `0x41700000` (15) at `0xa54`, and overrides duration with `0x40e00000` (7) when `pev->playerclass` is 5.
- `CBasePlayer::TeamFortress_TakeConcussionBlast`, around `0xbb0e0`: the same duration/class branch is inlined into blast handling.
- `CBasePlayer::CheckTimeBasedDamage()`, `0xc97d3` onward: compares start + duration against current time and derives remaining concussion intensity from that interval.
- `CTFConcussionGrenade::setRadius()`, `0xf1720`: stores `0x438c0000` (280). `Explode()` uses this radius with `UTIL_FindEntityInSphere` before invoking concussion blast handling.

These are constants in the installed game, not verification of the remote server's binary or settings. No game binaries are redistributed or modified.

## Approximation and boundaries

The estimator checks 3D distance from the blast origin to each present, alive, non-observer player's sampled position. It interpolates nearby samples, avoids interpolating large position jumps, and ignores stale samples. It does not implement every engine eligibility condition, team/server restrictions, bounding-box sphere lookup, water rules, cures, or custom plugins. A nearby blast is therefore only possible exposure. No line-of-sight filter is imposed.

An all-zero explosion origin is ambiguous in the decoder and is skipped. Missing explosions or positions can cause false negatives; a lack of active estimate means unknown, not confirmed unaffected. Estimates end at the class duration, observed death, disconnect/track loss, class change, slot reuse or map change, whichever comes first. New blasts replace an older timer. This is deterministic when seeking forward or backward.

## Matched server logs

An optional `CACHE/concussion/<demo-id>.json` sidecar supplies independently aligned server-log events through `/api/demo/<id>/conc-log`. The Conc tab defaults to the matched log when available; unchecking “Use matched server log” restores the proximity estimate. File, map, demo duration, alignment evidence and player Steam IDs are checked before applying events. No raw console text is executed or inserted as HTML.

Open the desired round, then **drop its `.log` anywhere in the viewer**, or use **Choose log for this round…** in the Conc tab. The browser posts the file to `/api/demo/<id>/conc-log`; log files never enter the demo-upload route. Files are limited to 16 MB, and simultaneous multi-file drops are rejected to avoid pairing the wrong round. A successful attachment enables the matched log and invalidates the previous comparison. Switching demos during upload does not apply its response to the newly selected demo.

`server_log.py` parses supported text events and verifies the single map and Steam-ID kill pairs. Automatic attachment requires at least 20 matching kills, more than 80% coverage of eligible demo kills, a span exceeding one minute, both round ends covered, and residuals below 0.7 seconds. Recorded pause boundaries receive additional before/after coverage and offset checks when enough anchors exist. Insufficient pause anchors are disclosed in the UI; inconsistent pause timing is rejected. Whole-second log precision remains approximately ±1 second after alignment. No fixed timezone conversion or filename-clock assumption is used.

After validation, the original log is stored under `CACHE/logs/<demo-id>/<content-sha256>.log`, and the matched sidecar is atomically saved under `CACHE/concussion/<demo-id>.json`. Browser-provided filenames are display metadata, never storage paths. Originals are retained by content hash. Invalid uploads leave an existing pairing untouched. The Conc tab shows the attached filename, match count, timing precision and available pause-check result. The pairing persists across page reloads and viewer restarts.

Log events are labelled **LOGGED CONC · ESTIMATED TIMER**. The event is recorded by the server; remaining duration and visual experience are not measured by the log. Timers use the duration controls and stop at observed death, disconnect, track loss, class/map change, slot reuse, or a logged cure/spawn. Repeated events reset the timer. Events with no usable remaining interval still appear in the list. Log line ordering handles death/cure in the same timestamp second. Timeline bands and event links work when seeking in either direction. These remain live-viewer overlays, not video-export overlays.

The displayed countdown is the configured class duration minus unpaused time since the current event. It never counts down to a future death, cure or repeat concussion. Those events terminate or reset the indicator when reached; clipped timeline bands describe historical coverage separately. Recorded `svc_setpause` transitions freeze the countdown and extend its estimated expiry. The overlay says “game paused” during these intervals. Both blast and log modes use this clock; a track gap is bridged only when a recorded pause explains it. Duplicate pause messages do not double-count duration. Map changes close outstanding pauses; an unmatched pause lasts through the recorded demo end.

## Aim comparison by weapon

The Conc tab's **Compare firing aim by weapon** tests the recorded forward aim ray only at recorded weapon firing events. It intersects a visible enemy's server-model hitboxes, enlarged by the chosen margin on each side. A 10% margin increases each box dimension by 20% overall. Map solids stop the ray; X-ray display settings do not remove occlusion. No extra engine trace padding is added. Missing actor state, map or needed target hitboxes are excluded.

The percentage is **near-target firing events / firing events with an enemy in view**, separately for each weapon and conc state. Idle/held time and shots with no enemy visible contribute nothing. A target must be within the reconstructed rectangular screen, with map line of sight, within 3500 game units. Visibility is tested against normal hitboxes independently of the selected aim margin. An enemy behind a wall is not counted as an aim-near hit. Multiple targets do not double-count a firing event. One event may represent several bullets/pellets; this is not a bullet hit percentage.

Each cell also shows **aim-near / centre-ray intersections / fired / concs**. `centre-ray intersections` counts reconstructed aim-ray intersections with normal enemy hitboxes, with no added margin or extra trace padding. It uses the same sampled pose, map occlusion and range checks as aim-near, independently of the selected margin. Each firing event counts once even if several boxes or enemies intersect. This is a modelled intersection count, not server-confirmed damage or pellet hits; the result records `hitCountKind: unexpanded-hitbox-ray`. Both counts now use the same candidate-shooter target-position estimate as the margin and ordinary hitbox display when Lag comp is enabled. The earlier unrewound comparison was inconsistent and its reported percentages are superseded.

`concs` counts distinct logged event windows containing that weapon's usable firing events; repeated shots in one window count that window once. It is not the total concussions in the match, and outside-window rows show zero.

Groups now use explicit firing-event identities (`tf_acfire`, `tf_sg`, `tf_ssg`, `tf_rpg`, etc.), not model names, custom view-model geometry or player class. The full event stream includes reliable events; exact duplicate records are removed. Spin-up, reload, pump and explosion events do not count.

The decoder rounds event times to milliseconds while snapshot times retain floats. Snapshot selection tolerates up to 2 ms ahead to resolve the same packet across this rounding; otherwise it uses the preceding snapshot. It does not try multiple frames to maximize hits. A target whose death is recorded within the packet interval retains their preceding alive pose, at the death position when available. Target bone poses use the existing server-hitbox implementation. Hitscan target origins use the Lag comp setting; projectile aim geometry retains current positions.

Conc/non-conc classifications use the current log-based estimated windows. Firing events within ±1 second of a window start or end are excluded from both comparison groups. Settings changes and player changes invalidate the result. Clickable examples seek to the sampled snapshot, with the firing event timestamp retained in the result. “Non-conc” means outside the estimated windows, not independently verified absence of an effect.

Positive enemy damage entries are also counted by concussion state, with uncertain-boundary entries separate. They are not individual bullets and do not identify the damage weapon, so they are never attributed to the currently held gun. This analysis does not measure bullet spread, actual client-side concussion wobble, real hit accuracy, or cheating probability. Encounter distance, target movement, firing activity and other circumstances are not controlled between the groups.

## Damage timing candidates

An additional **Damage timing matches — inferred** table searches the same attacker's recorded firing events within ±1 second of each aligned positive enemy-damage row. A single candidate counts once even if several damage rows fall near it. Multiple candidates are reported as ambiguous damage entries, not hits. All firing weapon identities compete; mixed-weapon and projectile-only matches are kept separate. Candidate events and damage must agree on concussion state outside uncertain boundaries. Clickable single-candidate examples are for review.

These are timing associations, not confirmed shot-to-damage links. Even a lone hitscan candidate can coincide with damage from an earlier rocket, grenade, or another cause not represented in the firing list. The damage rows lack shot IDs, weapon names and pellet hit locations. In particular, rapid AC fire leaves many possible shots within a whole-second log timestamp. The original aim-near percentage and slash counts remain geometric; the new table does not turn them into actual hit accuracy.


## Recorded kills and blood evidence

The comparison also shows actual demo kill records by weapon, independently of firing-event geometry. Conc state is evaluated at the kill time, with boundary uncertainty in its own column; all three columns sum to the total. Recorded teamkills and suicides are excluded. A kill need not have a counted centre-ray intersection, and projectile kill state is not necessarily firing state.

The former “hitbox hits” label was misleading and is now “Centre-ray intersections (not successful shots)”. It does not measure successful pellets, spread or server-confirmed damage. The existing slash numbers are unchanged.

The same demo contains 4,490 decoded TE_BLOODSPRITE effects. These carry position and visual-effect parameters, but no shooter, victim, shot or pellet ID (Valve SDK common/const.h, TE_BLOODSPRITE). Blood-effect counts must not be treated as confirmed pellet counts.

## Blood, firing and damage association

The new **Shots with hit evidence** table precedes the geometric comparison. `blood_hits.js` matches all players' firing events against blood and the aligned log, then reports the selected player's direct-fire weapons. AC, ordinary/super shotgun, sniper rifle and auto rifle are supported; projectiles remain outside this analysis. Weapon grouping uses the firing event, not skins or class.

- A blood effect must fall within 75 ms of a recorded firing event. Its position must be within 16 world units of a target's reconstructed hitbox in the current or preceding available snapshot. A victim dying in the current packet retains the preceding alive pose. This allows limited snapshot mismatch but does not identify a pellet or hitgroup, and now uses candidate-shooter lag compensation for hitscan firing events when enabled. Other damage-source candidates retain current positions.
- Positive enemy damage must name that attacker and target within one second of the blood event. All recorded firing sources, including projectile events, compete. Multiple possible targets, missing nearby target models, blood shared by several shots, or one damage row compatible with several shots prevent unique attribution. No greedy nearest-shot assignment is made.
- A recorded explosion within 256 units and 100 ms of the blood, or a same-attacker/victim kill record naming another weapon within 75 ms, also makes that evidence ambiguous. Earlier projectiles and unrecorded causes can still yield incorrect associations; this is not an exhaustive damage-source simulation.
- Multiple blood effects, damage rows, victims or kill records associated with one firing event count that event once. Unique blood/damage associations give `blood-damage` status. A single same-attacker/weapon firing event within 75 ms of a hitscan kill gives `kill-confirmed` status, taking precedence without double-counting. Kills with no unique firing candidate remain separately listed; no firing events are invented.
- Every selected direct-fire event belongs to exactly one of `kill-confirmed`, `blood-damage`, `ambiguous`, or `unmatched`. Conc state is evaluated at the firing timestamp; uncertain boundaries have their own column. The denominator now includes only recorded events for that weapon with an enemy visible on the reconstructed screen. It is independent of the aim padding setting. The matching graph still includes all events to preserve competing explanations; the screen filter applies to the final numerator and denominator together. `unmatched` is unknown, not a miss.

The percentage is **shots with identified hit evidence and an enemy in view / firing events with an enemy in view**. It is not full shooting accuracy or a rigorous lower bound: missing evidence produces false negatives and inferred links may be wrong. All settings/thresholds are in the JSON result. Clickable review entries and a per-shot CSV retain accepted blood-event IDs, log lines, victims, kill times, ambiguity reasons and candidate evidence. Seeking, player/settings changes and cancellation use the existing comparison lifecycle.

Tests cover multiple pellets/damage rows per shot, competing shooters, overlapping targets, missing poses, shared log rows, explosions, conflicting kill weapons, team damage, kill deduplication, missing firing events, conc boundaries, accounting and cancellation. Browser checks verify both players, all 12 shotgun kills accounted for, unique blood use, review seeking, CSV downloads and no browser errors. The original geometric results remain unchanged.

## Inclusive estimate and visible aim margin

At the user's request, the evidence table now displays **Strict** and **Inclusive** counts together. Strict is the preceding identified-evidence measure, including inferred unique blood/damage links; the word strict does not mean guaranteed server shot attribution. The inclusive count adds plausible ambiguous associations when the recorded aim ray enters the victim's padded hitbox, using the same snapshot, padding, forward cone, wall trace and range as the geometric aim check. Nearby-explosion and competing-shot cases may qualify; missing/overlapping targets and conflicting kill weapons do not. This is an estimate, not a probability or confirmed pellet count.

The inclusive assignment reserves evidence belonging to strict associations or uniquely kill-linked shots across all attackers first. Remaining eligible edges are considered by closest blood-to-firing time, then log-to-blood time, then stable IDs for ties. Each blood effect and damage row is allocated once, and each firing event contributes at most one additional match. This deterministic heuristic can choose incorrectly and does not solve missing evidence. The CSV includes the extra association's blood ID, damage line and victim. Existing strict statuses/counts are retained independently.

**Draw aim margin on enemies** displays cyan normal hitboxes and yellow padded outlines for enemies of the selected player. Shapes use the aim comparison's snapshot, candidate-shooter lag estimate and shared target-death handling. The display obeys the X-ray visibility setting; drawing a box does not bypass the analysis's wall checks or mean that target is eligible. The ordinary Hitboxes and margin overlay now share target placement in the same selected-player POV. Historical shot flashes may still show an older shot location. Both drawing and calculations clamp the margin to 0–200% per side. At 30%, a dimension grows by 60%; at 100%, it triples. Editing the margin redraws immediately and invalidates the previous comparison, which must be rerun.

**Timing uncertain** specifically means uncertain concussion state at firing, within the existing ±1-second boundary allowance. A shot may have confirmed kill evidence and still have uncertain concussion status. This differs from ambiguous attribution of logged damage to a particular firing event.

Browser verification covers visible overlay geometry, 100% and 200% input/calculation values, immediate stale-result invalidation, inclusive accounting, one-use damage/blood assignments and stable strict counts across margin settings. The original aim comparison is regression-checked separately.


## Corrected target-position basis

`concTargetAt` now supplies shared death handling and target origin reconstruction. The margin overlay, ordinary body hitboxes, hitscan aim geometry and inclusive margin check use this basis. Blood association reconstructs the candidate shooter's target poses at the firing snapshot (plus the existing preceding-snapshot allowance); matching therefore receives the candidate firing event rather than locating blood once for every shooter. Other projectile candidates are evaluated without rewind. Lag-compensation changes immediately invalidate cached comparisons, and results record the setting.

The inherited rewind model is scoreboard ping (capped at 500 ms) plus an assumed 100 ms interpolation. Exact server settings, client commands and per-shot trace state are not recorded here. Do not describe the new figures as exact accuracy or proof of cheating. One of the 12 kill examples fits the unrewound position better, which is an explicit limit of this estimate.

Browser regression checks verified all 80 cyan base boxes match ordinary hitbox corners at the same POV/snapshot, with Lag comp both on and off, plus stale-result invalidation, both players' corrected results, original kill totals, per-shot accounting and CSV export. Earlier reports without lagCompensation metadata should be treated as historical and recomputed.


## Enemy-visible shot denominator

At the user's request, all displayed aim-near and strict/inclusive hit-evidence percentages now exclude shots fired with no enemy visible on the reconstructed screen. The numerator is filtered along with the denominator; an off-screen shot with kill/damage evidence is retained in the audit but not counted in the filtered percentage. Shots with missing player, map or visibility information are separately excluded, never treated as misses. Zero eligible shots display no percentage. Kill totals remain whole-round records.

A shared visibility evaluator reconstructs the shooter's recorded view angles and estimated target positions, independently of the viewer's free camera, X-ray setting, window size, selected aim margin or weapon. It uses the default game FOV of 90 degrees horizontal at 4:3 (vertical tangent 0.75), adjusted by the **Assumed player screen** setting: 4:3, 16:9 or 16:10. Normal hitbox faces are clipped against all screen edges and the near/far planes; their clipped vertices and face centres are tested against map solids. This includes partial-screen targets and visible limbs, rather than only player centres. The existing 3500-unit analysis range is retained. Exact client FOV/aspect, visual effects, per-pixel occlusion and server timing are not available, so this remains an estimated screen-visibility test.

The filter requires at least one visible enemy, not necessarily the eventual damaged opponent. Missing a shot while an enemy is in view still counts. Unknown visibility is excluded even if a hit is confirmed; all raw shot records retain their evidence status, visibility state, visible target slots and inclusion flag in JSON/CSV. Ambiguous evidence cannot become unique simply because a competing shot was off-screen: matching happens before filtering. The inclusive margin check uses the same visible-target set.

Changing screen format invalidates results. Increasing margin does not increase the eligible-shot count.

Verification covers front/behind/side/vertical FOV limits, partial-screen and screen-filling boxes, wall occlusion, widescreen differences, range limits, adding 100 no-enemy prefires without changing percentages, excluding evidence from both numerator and denominator, retaining raw evidence, zero denominators, matching geometry/evidence denominators, X-ray invariance, missing-map handling, screen-format invalidation and CSV export.

"""Parse text server logs and align them to a decoded demo. Never execute log text."""
import collections
import datetime
import re
import statistics


class LogError(ValueError):
    pass


IDENTITY = re.compile(r'"(.*?)<(\d+)><([^>]*)><([^>]*)>"')
STAMP = re.compile(r'^L (\d{2}/\d{2}/\d{4} - \d{2}:\d{2}:\d{2}): (.*)$')
TEAMS = {'Red', 'Blue', 'Yellow', 'Green'}


def align_log(raw, name, meta):
    if not meta.get('game', '').lower().startswith('tfc'):
        raise LogError('This log analysis currently supports TFC demos.')
    if b'\0' in raw or raw.startswith(b'HLDEMO'):
        raise LogError('Choose a plain-text server .log file.')
    events, maps, base = [], set(), None
    last_clock = None
    for line_number, line in enumerate(raw.decode('utf-8-sig', errors='replace').splitlines(), 1):
        match = STAMP.match(line)
        if not match:
            continue
        date, body = match.groups()
        try:
            clock = datetime.datetime.strptime(date, '%m/%d/%Y - %H:%M:%S')
        except ValueError:
            raise LogError('The log contains an invalid timestamp.') from None
        if last_clock is not None and clock < last_clock:
            raise LogError('The log clock moves backwards. Choose a log for one round.')
        last_clock = clock
        if base is None:
            base = clock
        map_match = re.search(r'^Loading map "([^"]+)"', body)
        if map_match:
            maps.add(map_match[1])
        people = IDENTITY.findall(body)
        kind = None
        if ' triggered "Concussion_Grenade" against ' in body: kind = 'conc'
        elif ' triggered "Medic_Cured_Concussion" against ' in body: kind = 'cure'
        elif ' killed ' in body: kind = 'kill'
        elif ' damaged ' in body: kind = 'damage'
        elif ' committed suicide with ' in body: kind = 'death'
        elif ' changed role to ' in body: kind = 'class'
        elif ' disconnected' in body: kind = 'disconnect'
        elif ' triggered "info_player_teamspawn"' in body: kind = 'spawn'
        needed = 2 if kind in ('conc', 'cure', 'kill', 'damage') else 1
        if not kind or len(people) != needed:
            continue
        amount = re.search(r' for (\d+(?:\.\d+)?)', body) if kind == 'damage' else None
        events.append(dict(t=(clock-base).total_seconds(), kind=kind, people=people,
                           line=line_number, clock=date, amount=float(amount[1]) if amount else None))
        if len(events) > 200000:
            raise LogError('This log is too large to match safely. Choose one round.')
    if not events or base is None:
        raise LogError('No supported server-log events were found in this file.')
    if maps != {meta.get('map')}:
        raise LogError('The log must contain the same single map as the open demo.')

    def player_at(slot, t):
        players = [p for p in meta['players'] if p['ent'] == slot and p['first'] <= t and
                   (p.get('left') is None or p['left'] >= t)]
        return players[0].get('steam') if len(players) == 1 else None

    logkills = collections.defaultdict(list)
    for e in events:
        if e['kind'] == 'kill':
            logkills[(e['people'][0][2], e['people'][1][2])].append(e)
    eligible = []
    for t, attacker, victim, *_ in meta.get('kills', []):
        key = (player_at(attacker, t), player_at(victim, t))
        if attacker != victim and all(key) and all(s.startswith('STEAM_') for s in key):
            eligible.append((t, key))
    if len(eligible) < 20:
        raise LogError('At least 20 recorded player kills are needed to verify this pairing.')
    count = sum(len(logkills[key]) for _, key in eligible)
    if count > 500000:
        raise LogError('Too many possible matches. Choose a server log for one round.')
    offsets = sorted(t-e['t'] for t, key in eligible for e in logkills[key])
    if not offsets:
        raise LogError('No matching player kills were found. This may be a different round.')
    best, left = (0, 0), 0
    for right, value in enumerate(offsets):
        while value-offsets[left] > 1.1:
            left += 1
        if right-left > best[1]-best[0]:
            best = left, right
    offset = statistics.median(offsets[best[0]:best[1]+1])
    anchors, used = [], set()
    for t, key in eligible:
        if not logkills[key]:
            continue
        e = min(logkills[key], key=lambda x: abs(t-(x['t']+offset)))
        if abs(t-(e['t']+offset)) <= .65 and e['line'] not in used:
            anchors.append((t, e['t']))
            used.add(e['line'])
    if len(anchors) < 20 or len(anchors)/len(eligible) <= .8:
        raise LogError('The log does not reliably match this demo (only %d of %d player kills matched). '
                       'Open the correct round, then drop its log.' % (len(anchors), len(eligible)))
    anchors.sort()
    if anchors[-1][0]-anchors[0][0] <= 60:
        raise LogError('Matching kills must span more than one minute to verify the timing.')
    offset = statistics.median(t-lt for t, lt in anchors)
    residual = max(abs(t-lt-offset) for t, lt in anchors)
    if residual >= .7:
        raise LogError('The log and demo clocks do not align consistently.')
    # Require coverage at both ends, not just a dense matching excerpt.
    span = max(t for t, _ in eligible)-min(t for t, _ in eligible)
    edge_allowance = max(10, span*.05)
    if (anchors[0][0]-min(t for t, _ in eligible) > edge_allowance or
            max(t for t, _ in eligible)-anchors[-1][0] > edge_allowance):
        raise LogError('The log does not cover both ends of this round.')

    pauses, pause_start = [], None
    for p in sorted(meta.get('pauses', []), key=lambda p: p['t']):
        if p['paused'] and pause_start is None:
            pause_start = p['t']
        elif not p['paused'] and pause_start is not None:
            before = [(t, lt) for t, lt in anchors if t < pause_start-1]
            after = [(t, lt) for t, lt in anchors if t > p['t']+1]
            checked = len(before) >= 3 and len(after) >= 3
            delta = None
            if checked:
                delta = statistics.median(t-lt for t, lt in after)-statistics.median(t-lt for t, lt in before)
                for side, all_side in [(before, [t for t, _ in eligible if t < pause_start-1]),
                                       (after, [t for t, _ in eligible if t > p['t']+1])]:
                    if len(side)/len(all_side) <= .8:
                        raise LogError('Too few kills match on one side of the pause. The old pairing has been kept.')
                if abs(delta) > .7:
                    raise LogError('The log clock shifts across the pause. Automatic pairing was not applied.')
            pauses.append(dict(start=pause_start, end=p['t'], checked=checked,
                               before=len(before), after=len(after), offsetChange=round(delta, 3) if delta is not None else None))
            pause_start = None

    rows, stops, combat = [], [], []
    for e in events:
        t = e['t']+offset
        if not meta['start'] <= t <= meta['end']:
            continue
        target = e['people'][1] if e['kind'] in ('conc', 'cure', 'kill', 'damage') else e['people'][0]
        candidates = [p for p in meta['players'] if p.get('steam') == target[2] and p['first'] <= t+1 and
                      (p.get('left') is None or p['left'] >= t-1)]
        if len(candidates) != 1:
            continue
        p = candidates[0]
        row = dict(t=round(t, 3), slot=p['ent'], steam=p['steam'], line=e['line'], clock=e['clock'])
        if e['kind'] in ('kill', 'damage'):
            attacker = e['people'][0]
            sources = [a for a in meta['players'] if a.get('steam') == attacker[2] and a['first'] <= t+1 and
                       (a.get('left') is None or a['left'] >= t-1)]
            if len(sources) == 1:
                combat.append(dict(row, kind=e['kind'], attacker=sources[0]['ent'], attackerSteam=attacker[2],
                                   amount=e['amount'], enemy=attacker[3] in TEAMS and target[3] in TEAMS and attacker[3] != target[3]))
        if e['kind'] == 'conc':
            rows.append(dict(row, source=e['people'][0][0], sourceSteam=e['people'][0][2],
                             self=e['people'][0][2] == p['steam']))
        elif e['kind'] in ('cure', 'kill', 'death', 'spawn', 'class', 'disconnect'):
            stops.append(dict(row, reason=e['kind']))
    return dict(version=1, file=meta['file'], map=meta['map'], demoEnd=meta['end'], log=name,
                alignment=dict(offset=round(offset, 3), anchors=len(anchors), eligibleKills=len(eligible),
                               maxResidual=round(residual, 3), uncertainty=1, clockOrigin=base.isoformat(),
                               anchorSpan=[anchors[0][0], anchors[-1][0]], pauses=pauses),
                events=rows, stops=stops, combat=combat)

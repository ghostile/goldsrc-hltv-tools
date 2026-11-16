'use strict';
// Geometric aim proximity, not bullet accuracy or a measurement of client-side wobble.
const ConcAim = (() => {
  function stateAt(events, t, uncertainty = 1) {
    if (events.some(e => Math.abs(t - e.t) <= uncertainty || Math.abs(t - e.end) <= uncertainty)) return 'uncertain';
    return events.some(e => t >= e.t && t < e.end) ? 'conc' : 'outside';
  }
  function expanded(h, margin) {
    return { ...h, min: h.min.map((v, i) => v - (h.max[i] - v) * margin),
      max: h.max.map((v, i) => v + (v - h.min[i]) * margin) };
  }
  // Clip all six box faces to the view frustum. Sampling the clipped face
  // centres and vertices catches partial-screen targets and boxes containing
  // the view ray, even when every original corner is off screen.
  function visibleBox(corners, eye, basis, aspect, clear, far = 3500) {
    const points=[];
    for(let i=0;i<8;i++){
      const w=Array.from(corners.slice(i*3,i*3+3)),v=w.map((x,k)=>x-eye[k]);
      points.push([v.reduce((n,x,k)=>n+x*basis.right[k],0),v.reduce((n,x,k)=>n+x*basis.up[k],0),
        v.reduce((n,x,k)=>n+x*basis.forward[k],0),...w]);
    }
    const tx=.75*aspect,ty=.75; // Default 90-degree horizontal FOV at 4:3.
    const planes=[[0,0,1,-.01],[0,0,-1,far],[1,0,tx,0],[-1,0,tx,0],[0,1,ty,0],[0,-1,ty,0]];
    const faces=[[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
    for(const face of faces){
      let poly=face.map(i=>points[i]);
      for(const plane of planes){
        const clipped=[];
        for(let i=0;i<poly.length;i++){
          const a=poly[i],b=poly[(i+1)%poly.length];
          const da=plane[0]*a[0]+plane[1]*a[1]+plane[2]*a[2]+plane[3];
          const db=plane[0]*b[0]+plane[1]*b[1]+plane[2]*b[2]+plane[3];
          if(da>=0)clipped.push(a);
          if((da>=0)!==(db>=0)){const f=da/(da-db);clipped.push(a.map((v,k)=>v+(b[k]-v)*f));}
        }
        poly=clipped;if(!poly.length)break;
      }
      if(!poly.length)continue;
      const centre=[0,0,0];
      for(const p of poly)for(let k=0;k<3;k++)centre[k]+=p[k+3]/poly.length;
      if(clear(centre)||poly.some(p=>clear(p.slice(3))))return true;
    }
    return false;
  }
  function eventFrame(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    // Events are rounded to milliseconds by the decoder; snapshots keep floats.
    // Resolve the same packet on either side of that rounding, not a full tick earlier.
    if (lo < times.length && times[lo] - t <= .002) return lo;
    return lo - 1;
  }
  // Unlike Studio.rayHitbox, no additional engine trace padding is applied.
  function rayHit(h, bones, p, d, maxDist) {
    const o = h.bone * 12;
    let low = 0, high = maxDist;
    for (let a = 0; a < 3; a++) {
      const nx = bones[o + a], ny = bones[o + 4 + a], nz = bones[o + 8 + a];
      const rel = (p[0] - bones[o + 3]) * nx + (p[1] - bones[o + 7]) * ny + (p[2] - bones[o + 11]) * nz;
      const dir = d[0] * nx + d[1] * ny + d[2] * nz;
      if (Math.abs(dir) < 1e-9) { if (rel < h.min[a] || rel > h.max[a]) return false; continue; }
      let t0 = (h.min[a] - rel) / dir, t1 = (h.max[a] - rel) / dir;
      if (t0 > t1) [t0, t1] = [t1, t0];
      low = Math.max(low, t0); high = Math.min(high, t1);
      if (low > high) return false;
    }
    return true;
  }
  const fireWeapons = {
    tf_acfire: ['ac', 'AC'], tf_sg: ['shotgun', 'Shotgun'], tf_ssg: ['super_shotgun', 'Super shotgun'],
    tf_rpg: ['rpg', 'Rocket launcher'], tf_gl: ['grenade_launcher', 'Grenade launcher'], tf_pipel: ['pipe_launcher', 'Pipe launcher'],
    tf_nail: ['nailgun', 'Nailgun'], tf_snail: ['super_nailgun', 'Super nailgun'], tf_sniper: ['sniper', 'Sniper rifle'],
    tf_ar: ['auto_rifle', 'Auto rifle'], tf_rail: ['railgun', 'Railgun'], tf_tranq: ['tranquilizer', 'Tranquilizer'],
    tf_ic: ['incendiary', 'Incendiary cannon'], tf_flame: ['flamethrower', 'Flamethrower']
  };
  function firingEvents(meta, D, slot) {
    const out = [], seen = new Set();
    let duplicates = 0;
    if (!meta.buffers.events) return { events: out, duplicates };
    const [offset, bytes] = meta.buffers.events, E = new Float32Array(D.buf, offset, bytes / 4);
    const levels = meta.levels?.length ? meta.levels : [{ t: meta.start, events: meta.events }];
    for (let o = 0; o + 15 < E.length; o += 16) {
      if (E[o + 1] !== slot) continue;
      const t = E[o];
      let li = levels.length - 1;
      while (li > 0 && levels[li].t > t) li--;
      const name = (levels[li].events?.[E[o + 2]] || '').toLowerCase();
      const match = /(?:^|\/)wpn\/(tf_\w+)\.sc$/.exec(name), weapon = match && fireWeapons[match[1]];
      if (!weapon || !Number.isFinite(t)) continue; // Spin-up, reload, pump and explosions are not firing events.
      const key = `${li}|${Array.from(E.subarray(o, o + 16)).join('|')}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      out.push({ t, slot, weapon: weapon[0], label: weapon[1], event: name });
    }
    out.sort((a, b) => a.t - b.t);
    return { events: out, duplicates };
  }
  const bucket = () => ({ firingEvents: 0, nearEvents: 0, visibleEvents: 0, shotsHit: 0, concCount: 0, excludedNoEnemyEvents: 0 });
  const percent = (n, d) => d > 0 ? 100 * n / d : null;
  function damageLinks({ fires, combat, slot, events, tolerance = 1, uncertainty = 1 }) {
    const direct = new Set(['ac', 'shotgun', 'super_shotgun', 'sniper', 'auto_rifle']);
    const result = { tolerance, rows: {}, mixedOrProjectileEntries: 0, noCandidateEntries: 0, uncertainEntries: 0, examples: [] };
    const shots = fires.filter(f => f.slot === slot), unique = new Map();
    for (const d of combat || []) {
      if (d.kind !== 'damage' || d.attacker !== slot || !d.enemy || !(d.amount > 0)) continue;
      const state = stateAt(events, d.t, uncertainty);
      if (state === 'uncertain') { result.uncertainEntries++; continue; }
      // Keep every weapon as a competing cause, even when only direct-fire
      // weapon rows are summarized. Never attribute by the held skin alone.
      const candidates = shots.map((f, index) => ({ ...f, index })).filter(f => Math.abs(f.t - d.t) <= tolerance);
      if (!candidates.length) { result.noCandidateEntries++; continue; }
      const weapons = new Set(candidates.map(f => f.weapon));
      const weapon = candidates[0].weapon;
      if (weapons.size !== 1 || !direct.has(weapon)) { result.mixedOrProjectileEntries++; continue; }
      if (candidates.some(f => stateAt(events, f.t, uncertainty) !== state)) { result.uncertainEntries++; continue; }
      const make = () => ({ singleCandidateShots: 0, singleCandidateDamageEntries: 0, multipleCandidateDamageEntries: 0 });
      const row = result.rows[weapon] ||= { label: candidates[0].label, conc: make(), outside: make() };
      const b = row[state];
      if (candidates.length === 1) {
        b.singleCandidateDamageEntries++;
        const key = weapon + ':' + state;
        let seen = unique.get(key);
        if (!seen) unique.set(key, seen = new Set());
        seen.add(candidates[0].index); b.singleCandidateShots = seen.size;
        result.examples.push({ weapon, state, damageTime: d.t, shotTime: candidates[0].t,
          victim: d.slot, amount: d.amount, line: d.line });
      } else b.multipleCandidateDamageEntries++;
    }
    return result;
  }
  function killCounts({ kills = [], slot, events, start = -Infinity, end = Infinity, uncertainty = 1 }) {
    const rows = {};
    const labels = {supershotgun: 'Super shotgun', shotgun: 'Shotgun', ac: 'AC', rocket: 'Rocket launcher',
      normalgrenade: 'Hand grenade', nailgrenade: 'Nail grenade', sentrygun: 'Sentry gun'};
    for (const [t, attacker, victim, weapon] of kills) {
      if (attacker !== slot || victim === attacker || !victim || weapon === 'teammate' || t < start || t > end) continue;
      const row = rows[weapon] ||= {label: labels[weapon] || weapon, conc: 0, outside: 0, uncertain: 0, total: 0};
      row[stateAt(events, t, uncertainty)]++;
      row.total++;
    }
    return rows;
  }
  async function measure({ start, end, events, fires, combat, kills = [], slot, sample, margin = .1, uncertainty = 1, progress, cancelled }) {
    const result = { mode: 'firing-events', denominator:'enemy-visible-firing-events', hitCountKind: 'unexpanded-hitbox-ray', margin, uncertainty, rows: {}, excludedBoundaryEvents: 0, unavailableEvents: 0, excludedNoEnemyEvents: 0,
      damage: { conc: { entries: 0, amount: 0 }, outside: { entries: 0, amount: 0 }, uncertain: { entries: 0, amount: 0 } } };
    const shots = fires.filter(e => e.slot === slot && e.t >= start && e.t <= end);
    const concWindows = new Map();
    const count = result.recordedFiringEvents = shots.length;
    for (let i = 0; i < count; i++) {
      if (i % 100 === 0) {
        if (cancelled?.()) return null;
        progress?.(i / count);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const shot = shots[i], t = shot.t;
      const state = stateAt(events, t, uncertainty);
      if (state === 'uncertain') { result.excludedBoundaryEvents++; continue; }
      const p = sample(t, margin, shot);
      if (!p) { result.unavailableEvents++; continue; }
      const row = result.rows[shot.weapon] ||= { label: shot.label, conc: bucket(), outside: bucket(), examples: { conc: [], outside: [] } };
      const b = row[state];
      if(!p.visible){b.excludedNoEnemyEvents++;result.excludedNoEnemyEvents++;continue;}
      b.firingEvents++;
      if (state === 'conc') {
        let windows = concWindows.get(shot.weapon);
        if (!windows) concWindows.set(shot.weapon, windows = new Set());
        const index = events.findIndex(e => t >= e.t && t < e.end);
        if (index >= 0) windows.add(index);
        b.concCount = windows.size;
      }
      if (p.visible) b.visibleEvents++;
      if (p.hit && p.visible) b.shotsHit++; // One normal-hitbox intersection per firing event, not per pellet or box.
      if (p.near && p.visible) {
        b.nearEvents++;
        const examples = row.examples[state];
        if (examples.length < 3 && (!examples.length || t - examples[examples.length - 1].t > 1))
          examples.push({ t: p.sampleTime ?? t, firingTime: t, target: p.target });
      }
    }
    for (const row of Object.values(result.rows)) for (const state of ['conc', 'outside']) {
      const b = row[state];
      b.nearPercent = percent(b.nearEvents, b.firingEvents);
    }
    // Damage lines do not identify the weapon. Never assign them to whichever gun
    // happens to be held: delayed rockets/grenades would contaminate that breakdown.
    for (const e of combat || []) {
      if (e.attacker !== slot || e.kind !== 'damage' || !e.enemy || !(e.amount > 0) || e.t < start || e.t > end) continue;
      const b = result.damage[stateAt(events, e.t, uncertainty)];
      b.entries++; b.amount += e.amount;
    }
    progress?.(1);
    result.damageLinks = damageLinks({ fires: shots, combat, slot, events, uncertainty });
    result.kills = killCounts({kills, slot, events, start, end, uncertainty});
    return result;
  }
  return { stateAt, expanded, visibleBox, eventFrame, rayHit, firingEvents, damageLinks, killCounts, measure };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ConcAim;

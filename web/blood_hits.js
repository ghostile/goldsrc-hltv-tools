'use strict';
// Evidence association, not a reconstruction of random pellet spread.
const BloodHits = (() => {
  const direct = new Set(['ac', 'shotgun', 'super_shotgun', 'sniper', 'auto_rifle']);
  const killWeapons = { ac: 'ac', shotgun: 'shotgun', supershotgun: 'super_shotgun',
    sniperrifle: 'sniper', autorifle: 'auto_rifle' };
  function range(rows, t, tolerance) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t < t - tolerance) lo = m + 1; else hi = m; }
    const out = [];
    for (; lo < rows.length && rows[lo].t <= t + tolerance; lo++) out.push(rows[lo]);
    return out;
  }
  function effects(meta, D) {
    const blood = [], explosions = [];
    if (!meta.buffers.tents) return { blood, explosions };
    const [offset, bytes] = meta.buffers.tents, T = new Float32Array(D.buf, offset, bytes / 4);
    for (let o = 0; o + 15 < T.length; o += 16) {
      if (T[o + 1] !== 115 && T[o + 1] !== 3) continue;
      const e = { id: o / 16, t: T[o], pos: Array.from(T.subarray(o + 2, o + 5)) };
      if (!Number.isFinite(e.t) || !e.pos.every(Number.isFinite)) continue;
      (T[o + 1] === 115 ? blood : explosions).push(e);
    }
    for (const rows of [blood, explosions]) rows.sort((a, b) => a.t - b.t);
    return { blood, explosions };
  }
  function pointDistance(h, bones, point) {
    const o = h.bone * 12;
    let squared = 0;
    for (let a = 0; a < 3; a++) {
      const v = (point[0] - bones[o + 3]) * bones[o + a] +
        (point[1] - bones[o + 7]) * bones[o + 4 + a] + (point[2] - bones[o + 11]) * bones[o + 8 + a];
      squared += Math.max(h.min[a] - v, 0, v - h.max[a]) ** 2;
    }
    return Math.sqrt(squared);
  }
  async function match({ fires, blood, explosions = [], combat = [], kills = [], slot, events,
    locateBlood, stateAt, start = -Infinity, end = Infinity, shotTolerance = .075,
    logTolerance = 1, spatialTolerance = 16, uncertainty = 1, withinMargin, aimMargin = null, shotVisibility, cancelled, progress }) {
    const shots = fires.filter(f => f.t >= start && f.t <= end).map((f, id) => ({...f, id})).sort((a,b)=>a.t-b.t);
    const selected = shots.filter(f => f.slot === slot && direct.has(f.weapon));
    const byId=new Map(shots.map(s=>[s.id,s]));
    const damage = combat.filter(d => d.kind === 'damage' && d.enemy && d.amount > 0 && d.t >= start && d.t <= end)
      .map((d, id) => ({...d, id}));
    const pairs = new Map();
    for (const d of damage) {
      const key = `${d.attacker}:${d.slot}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(d);
    }
    for (const list of pairs.values()) list.sort((a,b)=>a.t-b.t);
    const records = new Map(selected.map(f => [f.id, {...f, state: stateAt(events, f.t, uncertainty),
      status: 'unmatched', bloodIds: [], damageLines: [], candidateBloodIds: [], candidateDamageLines: [], victims: [], killTimes: [], reasons: []}]));
    const edges = [], bloodShots = new Map(), damageShots = new Map();
    const audit = { bloodEffects: blood.length, unassignedBlood: 0, ambiguousVictimBlood: 0, explosionBlood: 0 };
    function add(map, key, value) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); }
    for (let i = 0; i < blood.length; i++) {
      if (i % 100 === 0) {
        if (cancelled?.()) return null;
        progress?.(i / Math.max(1,blood.length));
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      const b = blood[i];
      const nearby = range(shots,b.t,shotTolerance);
      if (!nearby.length) continue;
      const explosive = range(explosions,b.t,.1).some(e=>Math.hypot(...e.pos.map((v,k)=>v-b.pos[k]))<=256);
      if (explosive) audit.explosionBlood++;
      let locatedAny=false,ambiguousAny=false;
      for (const f of nearby) {
        // Lag-compensated target position depends on the candidate shooter.
        const located=locateBlood(b,spatialTolerance,f),victims=[...new Set(located.slots)];
        if(victims.length)locatedAny=true;
        const uncertainVictim=victims.length!==1||located.missing;
        if(victims.length&&uncertainVictim)ambiguousAny=true;
        for (const victim of victims) {
        for (const d of range(pairs.get(`${f.slot}:${victim}`)||[],b.t,logTolerance)) {
          add(bloodShots,b.id,f.id); add(damageShots,d.id,f.id);
          const conflictingKill=kills.some(k=>k[1]===f.slot&&k[2]===victim&&Math.abs(k[0]-b.t)<=shotTolerance&&killWeapons[k[3]]!==f.weapon);
          edges.push({shot:f.id,blood:b.id,damage:d.id,line:d.line,victim,uncertainVictim,explosive,conflictingKill,
            dt:Math.abs(f.t-b.t),logDt:Math.abs(d.t-b.t)});
        }
        }
      }
      if(!locatedAny)audit.unassignedBlood++;
      if(ambiguousAny)audit.ambiguousVictimBlood++;
    }
    // Whole-second damage rows may be interchangeable even when blood timing
    // separates the firing events. Permit a pooled association only if DISTINCT
    // rows can support EVERY competing shot in the connected component. Include
    // dirty/projectile competitors in that budget; never count their blood as
    // clean evidence. A chosen row is a support allocation, not an exact pairing.
    const clean=e=>!e.uncertainVictim&&!e.explosive&&!e.conflictingKill&&
      bloodShots.get(e.blood).size===1&&direct.has(byId.get(e.shot).weapon);
    const shotEdges=new Map();
    for(const e of edges){if(!shotEdges.has(e.shot))shotEdges.set(e.shot,[]);shotEdges.get(e.shot).push(e);}
    const timedEdges=new Set(),visited=new Set();
    let pooledGroups=0,pooledShots=0;
    for(const first of shotEdges.keys()){
      if(visited.has(first))continue;
      const group=[],pending=[first],rowSeen=new Set();visited.add(first);
      while(pending.length){
        const id=pending.pop();group.push(id);
        for(const e of shotEdges.get(id)){
          if(rowSeen.has(e.damage))continue;rowSeen.add(e.damage);
          for(const other of damageShots.get(e.damage))if(!visited.has(other)){visited.add(other);pending.push(other);}
        }
      }
      // Bounded work on pathological/custom logs; retain the old strict matches.
      if(group.length>256||rowSeen.size<group.length)continue;
      const options=new Map(),owners=new Map(),chosen=new Map();
      for(const id of group){
        const all=shotEdges.get(id),good=all.filter(clean),unique=new Map();
        for(const e of good.length?good:all)if(!unique.has(e.damage))unique.set(e.damage,e);
        options.set(id,[...unique.values()].sort((a,b)=>a.line-b.line||a.blood-b.blood));
      }
      function assign(id,seen){
        for(const e of options.get(id)){
          if(seen.has(e.damage))continue;seen.add(e.damage);
          const owner=owners.get(e.damage);
          if(owner===undefined||assign(owner,seen)){owners.set(e.damage,id);chosen.set(id,e);return true;}
        }
        return false;
      }
      group.sort((a,b)=>options.get(a).length-options.get(b).length||byId.get(a).t-byId.get(b).t||a-b);
      if(!group.every(id=>assign(id,new Set())))continue;
      let added=0;
      for(const e of chosen.values())if(clean(e)&&damageShots.get(e.damage).size>1){timedEdges.add(e);added++;}
      if(added){pooledGroups++;pooledShots+=added;}
    }
    audit.pooledGroups=pooledGroups;audit.pooledShots=pooledShots;
    // A blood effect and an allocated damage row cannot credit multiple shots.
    for (const e of edges) {
      const r = records.get(e.shot);
      if (!r) continue;
      r.candidateBloodIds.push(e.blood); r.candidateDamageLines.push(e.line);
      const reasons = [];
      if (e.uncertainVictim) reasons.push('blood target uncertain');
      if (e.explosive) reasons.push('nearby explosion');
      if (e.conflictingKill) reasons.push('kill record names another weapon');
      if (bloodShots.get(e.blood).size !== 1) reasons.push('blood fits multiple shots');
      if (damageShots.get(e.damage).size !== 1 && !timedEdges.has(e)) reasons.push('damage row fits multiple shots');
      if (!reasons.length) {
        r.status = 'blood-damage';
        r.bloodIds.push(e.blood); r.damageLines.push(e.line); r.victims.push(e.victim);
        if(timedEdges.has(e))r.pooledLogSupport=true;
      } else {
        if (r.status === 'unmatched') r.status = 'ambiguous';
        r.reasons.push(...reasons);
      }
    }
    const unpairedKills = [];
    for (const [t,attacker,victim,weapon] of kills) {
      const mapped = killWeapons[weapon];
      if (attacker !== slot || attacker === victim || !mapped || t < start || t > end) continue;
      const candidates = range(shots,t,shotTolerance).filter(f=>f.slot===slot&&f.weapon===mapped);
      if (candidates.length === 1) {
        const r=records.get(candidates[0].id);
        r.status='kill-confirmed'; r.killTimes.push(t); r.victims.push(victim);
      } else unpairedKills.push({t,victim,weapon:mapped,state:stateAt(events,t,uncertainty),
        reason:candidates.length ? 'multiple firing candidates' : 'no recorded firing event'});
    }
    // Optional inclusive estimate: keep strict results intact. Assign each piece
    // of evidence at most once, preferring the closest blood/firing time. This
    // is an explicitly heuristic assignment, never promoted to confirmation.
    const usedBlood=new Set(),usedDamage=new Set(),assignedShots=new Set();
    const confirmedShots=new Set();
    for(const [t,attacker,victim,weapon] of kills){
      if(attacker===victim||!killWeapons[weapon])continue;
      const candidates=range(shots,t,shotTolerance).filter(s=>s.slot===attacker&&s.weapon===killWeapons[weapon]);
      if(candidates.length===1)confirmedShots.add(candidates[0].id);
    }
    for(const e of edges){
      const strict=!e.uncertainVictim&&!e.explosive&&!e.conflictingKill&&
        bloodShots.get(e.blood).size===1&&damageShots.get(e.damage).size===1;
      const confirmed=confirmedShots.has(e.shot);
      if(strict||confirmed||timedEdges.has(e)){usedBlood.add(e.blood);usedDamage.add(e.damage);assignedShots.add(e.shot);}
    }
    if(withinMargin){
      const ordered=[...edges].sort((a,b)=>a.dt-b.dt||a.logDt-b.logDt||a.shot-b.shot||a.damage-b.damage||a.blood-b.blood);
      for(const e of ordered){
        if(e.uncertainVictim||e.conflictingKill||usedBlood.has(e.blood)||usedDamage.has(e.damage)||assignedShots.has(e.shot))continue;
        const shot=byId.get(e.shot);
        if(!direct.has(shot.weapon)||!withinMargin(shot,e.victim))continue;
        usedBlood.add(e.blood);usedDamage.add(e.damage);assignedShots.add(e.shot);
        const r=records.get(e.shot);
        if(r&&r.status==='ambiguous')r.inclusiveMatch={bloodId:e.blood,damageLine:e.line,victim:e.victim};
      }
    }
    const rows = {};
    const bucket = () => ({fired:0,killConfirmed:0,bloodDamage:0,ambiguous:0,unmatched:0,identified:0,identifiedPercent:null,
      plausibleAdditional:0,inclusive:0,inclusivePercent:null,recorded:0,excludedNoEnemy:0,visibilityUnknown:0});
    for (const r of records.values()) {
      for (const key of ['bloodIds','damageLines','candidateBloodIds','candidateDamageLines','victims','killTimes','reasons']) r[key]=[...new Set(r[key])];
      const row=rows[r.weapon] ||= {label:r.label,conc:bucket(),outside:bucket(),uncertain:bucket()};
      const b=row[r.state];b.recorded++;
      const view=shotVisibility?shotVisibility(r):{state:'visible',targets:[]};
      r.visibility=view.state;r.visibleTargets=view.targets;r.includedInPercentage=view.state==='visible';
      if(view.state==='not-visible'){b.excludedNoEnemy++;continue;}
      if(view.state!=='visible'){b.visibilityUnknown++;continue;}
      b.fired++;
      if(r.inclusiveMatch)b.plausibleAdditional++;
      b[{'kill-confirmed':'killConfirmed','blood-damage':'bloodDamage',ambiguous:'ambiguous',unmatched:'unmatched'}[r.status]]++;
    }
    for (const row of Object.values(rows)) for (const state of ['conc','outside','uncertain']) {
      const b=row[state]; b.identified=b.killConfirmed+b.bloodDamage;
      b.identifiedPercent=b.fired ? 100*b.identified/b.fired : null;
      b.inclusive=b.identified+b.plausibleAdditional;
      b.inclusivePercent=b.fired ? 100*b.inclusive/b.fired : null;
    }
    progress?.(1);
    return {method:'blood-damage-and-kills-v5',logAssociation:'distinct rows supporting separately timed blood; pooled row allocations are not exact shot-to-row links',denominator:shotVisibility?'enemy-visible-firing-events':'all-recorded-firing-events',shotTolerance,logTolerance,spatialTolerance,uncertainty,aimMargin,
      rows,shots:[...records.values()],unpairedKills,audit};
  }
  return {effects,pointDistance,match,isHitscan:weapon=>direct.has(weapon)};
})();
if (typeof module !== 'undefined' && module.exports) module.exports=BloodHits;

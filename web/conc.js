'use strict';
// Proximity-based estimate, not a received Concuss status. See docs/concussion_estimate.md.
const ConcEstimate = (() => {
  const defaults = Object.freeze({ radius: 280, medic: 7, other: 15 });
  const valid = flags => (flags & 1) && !(flags & (4 | 8 | 16));
  function pauseIntervals(meta) {
    const intervals = [];
    let start = null;
    const transitions = [...(meta.pauses || [])];
    // A new level ends an outstanding pause from the preceding level.
    for (const lv of (meta.levels || []).slice(1)) transitions.push({t: lv.t, paused: false});
    transitions.sort((a, b) => a.t - b.t);
    for (const e of transitions) {
      if (!Number.isFinite(e.t)) continue;
      if (e.paused) { if (start == null) start = Math.max(meta.start, e.t); }
      else if (start != null) {
        if (e.t > start) intervals.push([start, Math.min(e.t, meta.end)]);
        start = null;
      }
    }
    if (start != null && start < meta.end) intervals.push([start, meta.end]);
    return intervals;
  }
  function elapsed(start, end, pauses = []) {
    return Math.max(0, end - start - pauses.reduce((n, [a, b]) =>
      n + Math.max(0, Math.min(end, b) - Math.max(start, a)), 0));
  }
  function expiry(t, duration, pauses) {
    if (duration <= 0) return t;
    let end = t + duration;
    for (const [a, b] of pauses) {
      if (a >= end) break;
      if (b > t) end += b - Math.max(t, a);
    }
    return end;
  }
  function atOrBefore(times, t) {
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  function build(meta, D, options = {}) {
    const settings = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = Number(options[key]);
      settings[key] = Number.isFinite(value) && value > 0 ? Math.min(key === 'radius' ? 1000 : 60, value) : fallback;
    }
    const pauses = pauseIntervals(meta);
    const result = { settings, pauses, bySlot: {}, blasts: 0, unlocated: 0, exposures: 0 };
    if (!/^tfc/i.test(meta.game || '') || !D.n || !meta.buffers.events) return result;
    const [offset, length] = meta.buffers.events;
    const events = new Float32Array(D.buf, offset, length / 4);
    const levels = meta.levels?.length ? meta.levels : [{ t: meta.start, frame: 0, events: meta.events }];
    const seen = new Set();
    const rows = [];
    for (let o = 0; o + 15 < events.length; o += 16) rows.push(o);
    rows.sort((a, b) => events[a] - events[b]); // Delayed events need not be logged in time order.
    for (const o of rows) {
      const t = events[o], fi = atOrBefore(D.times, t);
      let li = levels.length - 1;
      while (li > 0 && levels[li].t > t) li--;
      if (!/^(?:events\/)?explode\/tf_concuss\.sc$/i.test(levels[li].events?.[events[o + 2]] || '')) continue;
      const origin = [events[o + 3], events[o + 4], events[o + 5]];
      const key = [li, t.toFixed(3), ...origin].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      result.blasts++;
      // All-zero origin is ambiguous in this decoder: don't guess an explosion at world zero.
      if (!origin.every(Number.isFinite) || origin.every(x => x === 0)) { result.unlocated++; continue; }
      if (fi < 0 || t - D.times[fi] > .25) continue;
      for (const slot of D.slots) {
        const I = D.info[slot], P = D.pos[slot];
        if (!I || !P || !valid(I[fi])) continue;
        const cls = (I[fi] >> 8) & 15;
        if (!cls) continue;
        let position = Array.from(P.subarray(fi * 5, fi * 5 + 3));
        if (fi + 1 < D.n && valid(I[fi + 1]) && D.times[fi + 1] - D.times[fi] <= .25) {
          const next = Array.from(P.subarray((fi + 1) * 5, (fi + 1) * 5 + 3));
          if (Math.hypot(...next.map((x, k) => x - position[k])) < 300) {
            const dt = D.times[fi + 1] - D.times[fi];
            const f = dt > 0 ? (t - D.times[fi]) / dt : 0;
            position = position.map((x, k) => x + (next[k] - x) * f);
          }
        }
        const distance = Math.hypot(...position.map((x, k) => x - origin[k]));
        if (!Number.isFinite(distance) || distance > settings.radius) continue;
        const duration = cls === 5 ? settings.medic : settings.other;
        let end = Math.min(expiry(t, duration, pauses), meta.end, levels[li + 1]?.t ?? Infinity);
        // Never carry an estimate across a death, missing track, class change, or slot reuse.
        for (let k = fi + 1; k < D.n && D.times[k - 1] < end; k++) {
          const gap = elapsed(D.times[k - 1], D.times[k], pauses) > .25;
          if (!valid(I[k]) || ((I[k] >> 8) & 15) !== cls || gap) {
            end = Math.min(end, gap ? D.times[k - 1] : D.times[k]);
            break;
          }
        }
        for (const kill of meta.kills || []) if (kill[2] === slot && kill[0] >= t) end = Math.min(end, kill[0]);
        for (const p of meta.players || []) {
          if (p.ent !== slot) continue;
          if (p.first > t) end = Math.min(end, p.first);
          if (p.first <= t && p.left != null && p.left >= t) end = Math.min(end, p.left);
        }
        if (end <= t) continue;
        (result.bySlot[slot] ||= []).push({ t, end, duration, distance, cls, origin, pauses });
        result.exposures++;
      }
    }
    // A subsequent blast resets the timer; intervals must not resume an older effect afterwards.
    for (const list of Object.values(result.bySlot)) {
      for (let i = 0; i + 1 < list.length; i++) list[i].end = Math.min(list[i].end, list[i + 1].t);
    }
    return result;
  }
  function active(result, slot, t) {
    const list = result?.bySlot[slot] || [];
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) lo = mid + 1; else hi = mid; }
    const hit = list[lo - 1];
    return hit && t < hit.end ? hit : null;
  }
  // `end` clips timeline coverage at death/another conc/etc. It must not make
  // the displayed effect duration depend on events that have not happened yet.
  function remaining(hit, t) {
    return hit ? Math.max(0, hit.duration - elapsed(hit.t, t, hit.pauses)) : 0;
  }
  function withLog(meta, D, estimate, log) {
    if (log?.version !== 1 || log.file !== meta.file || log.map !== meta.map ||
        Math.abs(log.demoEnd - meta.end) > .01 || !Array.isArray(log.events) ||
        !(log.alignment?.anchors >= 20)) return estimate;
    const pauses = pauseIntervals(meta);
    const result = { ...estimate, pauses, bySlot: {}, exposures: 0, log };
    const stops = log.stops || [];
    for (const e of [...log.events].sort((a, b) => a.t - b.t || a.line - b.line)) {
      const t = e.t, slot = e.slot, I = D.info[slot], fi = atOrBefore(D.times, t);
      if (!Number.isFinite(t) || t < meta.start || t > meta.end || !I || fi < 0) continue;
      const player = meta.players.find(p => p.ent === slot && p.steam === e.steam &&
        p.first <= t + 1 && (p.left == null || p.left >= t - 1));
      if (!player) continue;
      const cls = (I[fi] >> 8) & 15;
      const duration = cls ? (cls === 5 ? result.settings.medic : result.settings.other) : 0;
      let end = Math.min(expiry(t, duration, pauses), meta.end, player.left ?? Infinity);
      for (const lv of meta.levels || []) if (lv.t > t) end = Math.min(end, lv.t);
      for (const p of meta.players) if (p.ent === slot && p.first > t) end = Math.min(end, p.first);
      for (const k of meta.kills || []) if (k[2] === slot && k[0] >= t) end = Math.min(end, k[0]);
      for (const stop of stops) {
        // Line order resolves a concussion and death/cure within the same logged second.
        if (stop.slot === slot && stop.steam === e.steam && stop.line > e.line && stop.t >= t)
          end = Math.min(end, stop.t);
      }
      for (let k = fi + 1; k < D.n && D.times[k - 1] < end; k++) {
        const gap = elapsed(D.times[k - 1], D.times[k], pauses) > .25;
        if (!valid(I[k]) || ((I[k] >> 8) & 15) !== cls || gap) {
          end = Math.min(end, gap ? D.times[k - 1] : D.times[k]);
          break;
        }
      }
      // Keep every logged event, even if death in the same second leaves no usable timer.
      (result.bySlot[slot] ||= []).push({ ...e, t, end: Math.max(t, end), duration, cls, logged: true, pauses });
      result.exposures++;
    }
    for (const list of Object.values(result.bySlot)) {
      for (let i = 0; i + 1 < list.length; i++) list[i].end = Math.min(list[i].end, list[i + 1].t);
    }
    return result;
  }
  return { defaults, build, active, remaining, withLog, pauseIntervals, elapsed };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ConcEstimate;

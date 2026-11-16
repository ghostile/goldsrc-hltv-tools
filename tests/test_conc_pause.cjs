const assert = require('node:assert/strict');
const C = require('../web/conc.js');
function fixture(cls=6) {
  const meta={game:'tfc',file:'test.dem',map:'test',start:0,end:140,
    pauses:[{t:5,paused:true},{t:5.1,paused:true},{t:105,paused:false}],
    players:[{ent:1,steam:'S1',first:0,left:null}],kills:[],levels:[{t:0}],buffers:{}};
  const times=Float32Array.from({length:2801},(_,i)=>i/20);
  const info=new Uint32Array(times.length).fill(1|(cls<<8));
  const D={n:times.length,times,info:{1:info}};
  const log={version:1,file:meta.file,map:meta.map,demoEnd:140,alignment:{anchors:30},
    events:[{t:2,slot:1,steam:'S1',line:1}],stops:[]};
  return {meta,D,log,estimate:{settings:C.defaults,bySlot:{}}};
}
const apply=f=>C.withLog(f.meta,f.D,f.estimate,f.log);
let f=fixture(),r=apply(f),h=r.bySlot[1][0];
assert.deepEqual(r.pauses,[[5,105]]);
assert.equal(h.end,117);
for(const t of [5,50,104,105]) assert.equal(C.remaining(C.active(r,1,t),t),12);
assert.equal(C.remaining(C.active(r,1,110),110),7);
assert.equal(C.remaining(C.active(r,1,3),3),14); // Seeking backwards.
assert.equal(C.active(r,1,117),null);
f=fixture(5);assert.equal(apply(f).bySlot[1][0].end,109); // Medic duration.
f=fixture();f.log.stops=[{slot:1,steam:'S1',t:106,line:2}];
r=apply(f);assert.equal(r.bySlot[1][0].end,106);assert.equal(C.remaining(C.active(r,1,105),105),12);
f=fixture();f.log.events.push({t:107,slot:1,steam:'S1',line:2});r=apply(f);
assert.equal(r.bySlot[1][0].end,107);assert.equal(C.remaining(C.active(r,1,107),107),15);
f=fixture();f.meta.pauses.push({t:110,paused:true},{t:115,paused:false});
assert.equal(apply(f).bySlot[1][0].end,122); // More than one pause.
f=fixture();f.meta.pauses=[{t:5,paused:true}];
r=apply(f);assert.equal(r.bySlot[1][0].end,140);assert.equal(C.remaining(C.active(r,1,139),139),12);
f=fixture();f.meta.levels.push({t:80});assert.deepEqual(C.pauseIntervals(f.meta),[[5,80]]);
// A missing-snapshot interval is bridged only if a recorded pause explains it.
f=fixture();f.D.times=Float32Array.from([...f.D.times].filter(t=>t<=5||t>=105));
f.D.n=f.D.times.length;f.D.info[1]=new Uint32Array(f.D.n).fill(1|(6<<8));
assert.equal(apply(f).bySlot[1][0].end,117);
f.meta.pauses=[];assert.equal(apply(f).bySlot[1][0].end,5);
// The nearby-blast estimator uses the same paused game clock.
f=fixture();const E=new Float32Array(16);E[0]=2;E[2]=30;E[3]=100;
f.meta.buffers.events=[0,E.byteLength];f.meta.levels[0].events={30:'events/explode/tf_concuss.sc'};
f.D.buf=E.buffer;f.D.slots=[1];f.D.pos={1:new Float32Array(f.D.n*5)};
r=C.build(f.meta,f.D);assert.equal(r.bySlot[1][0].end,117);
assert.equal(C.remaining(C.active(r,1,80),80),12);
console.log('PASS: pause/resume, frozen countdown, rewind, Medic duration, death, reconcussion, duplicate transitions, multiple/open pauses, map change, track gaps, log and blast modes');

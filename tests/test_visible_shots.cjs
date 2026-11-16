const assert=require('node:assert/strict');
const A=require('../web/conc_aim.js');
const B=require('../web/blood_hits.js');
const basis={right:[1,0,0],up:[0,1,0],forward:[0,0,1]};
const box=(min,max)=>Float64Array.from(Array.from({length:8},(_,i)=>[i&1?max[0]:min[0],i&2?max[1]:min[1],i&4?max[2]:min[2]]).flat());
const visible=(min,max,aspect=4/3,clear=()=>true)=>A.visibleBox(box(min,max),[0,0,0],basis,aspect,clear);
assert.equal(visible([-1,-1,10],[1,1,12]),true);
assert.equal(visible([-1,-1,-12],[1,1,-10]),false); // Behind.
assert.equal(visible([15,-1,10],[16,1,11]),false); // Beyond side edge.
assert.equal(visible([-1,9,10],[1,10,11]),false); // Above screen, despite being in front.
assert.equal(visible([9,-1,10],[12,1,11]),true); // Partial-screen target.
assert.equal(visible([-100,-100,10],[100,100,11]),true); // No original corner is on screen.
assert.equal(visible([-1,-1,10],[1,1,12],4/3,()=>false),false); // Wall blocks all samples.
assert.equal(visible([12,-1,10],[13,1,11],4/3),false);
assert.equal(visible([12,-1,10],[13,1,11],16/9),true);
assert.equal(visible([-1,-1,3600],[1,1,3601]),false);
(async()=>{
 const fire={t:5,slot:1,weapon:'ac',label:'AC'};
 const options={start:0,end:1000,slot:1,events:[],uncertainty:0,fires:[fire,{...fire,t:6}],sample:t=>({visible:true,near:t===5,hit:t===5})};
 const base=await A.measure(options);
 const prefires=Array.from({length:100},(_,i)=>({...fire,t:100+i}));
 const more=await A.measure({...options,fires:[...options.fires,...prefires],sample:t=>t>=100?{visible:false}:options.sample(t)});
 assert.equal(more.rows.ac.outside.firingEvents,2);
 assert.equal(more.rows.ac.outside.nearPercent,base.rows.ac.outside.nearPercent);
 assert.equal(more.excludedNoEnemyEvents,100);
 const b=await B.match({fires:[fire,{...fire,t:20},{...fire,t:30}],blood:[],slot:1,events:[],stateAt:A.stateAt,
  kills:[[5,1,2,'ac']],locateBlood:()=>({slots:[],missing:false}),
  shotVisibility:s=>({state:s.t===5?'not-visible':s.t===30?'unknown':'visible',targets:s.t===20?[2]:[]})});
 const row=b.rows.ac.outside;
 assert.equal(row.recorded,3);assert.equal(row.fired,1);assert.equal(row.excludedNoEnemy,1);assert.equal(row.visibilityUnknown,1);
 assert.equal(row.identified,0);assert.equal(row.identifiedPercent,0);
 assert.equal(b.shots[0].status,'kill-confirmed'); // Evidence remains in records but not in the filtered numerator.
 assert.equal(b.shots[0].includedInPercentage,false);
 const none=await B.match({fires:[fire],blood:[],slot:1,events:[],stateAt:A.stateAt,locateBlood:()=>({slots:[]}),
  shotVisibility:()=>({state:'not-visible',targets:[]})});
 assert.equal(none.rows.ac.outside.identifiedPercent,null); // Not a fabricated zero for 0 eligible shots.
 console.log('PASS: rectangular FOV, vertical and horizontal edges, clipped/large targets, walls, aspect ratio, range, prefiring invariance, both numerator/denominator exclusion, missing visibility, zero denominator, evidence retained');
})().catch(e=>{console.error(e);process.exitCode=1});

const assert=require('node:assert/strict');
const B=require('../web/blood_hits.js');
const A=require('../web/conc_aim.js');
const fire={t:5,slot:1,weapon:'super_shotgun',label:'Super shotgun'};
const blood={id:0,t:5,pos:[0,0,0]};
const damage={t:5,kind:'damage',attacker:1,slot:2,enemy:true,amount:10,line:10};
const fixture=()=>({fires:[fire],blood:[blood],combat:[damage],slot:1,events:[{t:1,end:10}],stateAt:A.stateAt,
 locateBlood:()=>({slots:[2],missing:false})});
(async()=>{
 let f=fixture(),r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.bloodDamage,1);
 f=fixture();f.blood=Array.from({length:12},(_,id)=>({...blood,id}));f.combat.push({...damage,line:11});
 r=await B.match(f);assert.equal(r.rows.super_shotgun.conc.identified,1); // 12 blood effects / 2 damage rows remain one shot.
 assert.equal(r.shots[0].bloodIds.length,12);
 f=fixture();f.fires.push({...fire,t:5.04});r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.identified,0);assert.equal(r.rows.super_shotgun.conc.ambiguous,2);
 f=fixture();f.fires.push({...fire,t:5.3});f.blood.push({...blood,id:1,t:5.3});r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.identified,0); // One coarse damage row cannot credit both shots.
 f=fixture();f.fires.push({...fire,slot:3});f.combat.push({...damage,attacker:3,line:11});r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.ambiguous,1); // Other shooters compete for the same blood.
 f=fixture();f.locateBlood=()=>({slots:[2,3],missing:false});r=await B.match(f);assert.equal(r.shots[0].status,'ambiguous');
 f=fixture();f.locateBlood=()=>({slots:[2],missing:true});r=await B.match(f);assert.equal(r.shots[0].status,'ambiguous');
 f=fixture();f.explosions=[{t:5,pos:[20,0,0]}];r=await B.match(f);assert.equal(r.shots[0].status,'ambiguous');
 f=fixture();f.combat=[{...damage,enemy:false}];r=await B.match(f);assert.equal(r.shots[0].status,'unmatched');
 f=fixture();f.blood=[];f.kills=[[5,1,2,'supershotgun'],[5,1,3,'supershotgun'],[8,1,2,'supershotgun']];r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.killConfirmed,1);assert.equal(r.unpairedKills.length,1);
 f=fixture();f.kills=[[5,1,2,'rocket']];r=await B.match(f);assert.equal(r.shots[0].status,'ambiguous');
 f=fixture();f.events=[{t:5,end:10}];r=await B.match(f);assert.equal(r.rows.super_shotgun.uncertain.identified,1);
 f=fixture();f.events=[];r=await B.match(f);assert.equal(r.rows.super_shotgun.outside.identified,1);
 for(const row of Object.values(r.rows))for(const key of ['conc','outside','uncertain']){
  const c=row[key];assert.equal(c.fired,c.killConfirmed+c.bloodDamage+c.ambiguous+c.unmatched);
 }
 assert.equal(await B.match({...fixture(),cancelled:()=>true}),null);
 f=fixture();f.fires.push({...fire,slot:3});f.combat.push({...damage,attacker:3,line:11});
 f.locateBlood=(b,tolerance,shot)=>({slots:shot.slot===1?[2]:[4],missing:false});
 r=await B.match(f);assert.equal(r.shots[0].status,'blood-damage'); // Target poses depend on the candidate shooter's clock.
 f=fixture();f.fires.push({...fire,t:5.04});f.withinMargin=()=>true;r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.identified,0);
 assert.equal(r.rows.super_shotgun.conc.inclusive,1); // One damage entry / blood effect cannot become two hits.
 assert.equal(r.shots.filter(s=>s.inclusiveMatch).length,1);
 f.withinMargin=()=>false;r=await B.match(f);assert.equal(r.rows.super_shotgun.conc.inclusive,0);
 f=fixture();f.explosions=[{t:5,pos:[0,0,0]}];f.withinMargin=()=>true;r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.identified,0);assert.equal(r.rows.super_shotgun.conc.inclusive,1);
 f.kills=[[5,1,2,'rocket']];r=await B.match(f);assert.equal(r.rows.super_shotgun.conc.inclusive,0);
 f=fixture();f.locateBlood=()=>({slots:[2,3],missing:false});f.withinMargin=()=>true;r=await B.match(f);
 assert.equal(r.rows.super_shotgun.conc.inclusive,0);
 const h={bone:0,min:[-1,-1,-1],max:[1,1,1]},bones=[1,0,0,10,0,1,0,20,0,0,1,30];
 assert.equal(B.pointDistance(h,bones,[10,20,30]),0);assert.equal(B.pointDistance(h,bones,[15,20,30]),4);
 console.log('PASS: blood/damage deduplication, competing shots/attackers, shared rows, missing/overlapping targets, explosions, team damage, kill confirmation, missing firing events, uncertain boundaries, accounting, cancellation, spatial distance');
})().catch(e=>{console.error(e);process.exitCode=1});

const assert=require('node:assert/strict');
const B=require('../web/blood_hits.js');
const A=require('../web/conc_aim.js');
const shot=t=>({t,slot:1,weapon:'ac',label:'AC'});
const blood=(id,t)=>({id,t,pos:[0,0,0]});
const damage=line=>({line,t:5.5,kind:'damage',attacker:1,slot:2,enemy:true,amount:10});
const fixture=()=>({fires:[shot(5),shot(5.3)],blood:[blood(0,5),blood(1,5.3)],combat:[damage(10),damage(11)],
 slot:1,events:[{t:1,end:10}],stateAt:A.stateAt,locateBlood:()=>({slots:[2],missing:false})});
function checkUnique(r){
 for(const key of ['bloodIds','damageLines']){
  const accepted=r.shots.flatMap(s=>s[key]);assert.equal(accepted.length,new Set(accepted).size);
 }
}
(async()=>{
 let f=fixture(),r=await B.match(f);
 assert.equal(r.rows.ac.conc.bloodDamage,2);assert.ok(r.shots.every(s=>s.pooledLogSupport));checkUnique(r);
 // Permuting interchangeable log rows changes neither accepted shot nor count.
 f.combat.reverse();let reversed=await B.match(f);
 assert.deepEqual(reversed.shots.map(s=>[s.t,s.status,s.damageLines]),r.shots.map(s=>[s.t,s.status,s.damageLines]));
 f=fixture();f.combat.pop();r=await B.match(f);assert.equal(r.rows.ac.conc.identified,0);
 f=fixture();f.fires.push(shot(5.6));f.blood.push(blood(2,5.6));r=await B.match(f);assert.equal(r.rows.ac.conc.identified,0);
 // Lots of blood effects from one shot must not increase the hit count.
 f=fixture();f.blood.push(...Array.from({length:10},(_,i)=>blood(i+2,5)));r=await B.match(f);
 assert.equal(r.rows.ac.conc.identified,2);checkUnique(r);
 // Same-time firing candidates cannot be separated by these blood timestamps.
 f=fixture();f.fires=[shot(5),shot(5.04)];f.blood=[blood(0,5),blood(1,5.04)];r=await B.match(f);
 assert.equal(r.rows.ac.conc.identified,0);
 // An explosion remains a competing source, even when log-row capacity is ample.
 f=fixture();f.explosions=[{t:5,pos:[0,0,0]}];r=await B.match(f);
 assert.equal(r.shots[0].status,'ambiguous');assert.equal(r.shots[1].status,'blood-damage');checkUnique(r);
 f=fixture();f.locateBlood=()=>({slots:[2,3],missing:false});r=await B.match(f);assert.equal(r.rows.ac.conc.identified,0);
 f=fixture();f.locateBlood=()=>({slots:[2],missing:true});r=await B.match(f);assert.equal(r.rows.ac.conc.identified,0);
 // A dirty competing shot still consumes capacity. It cannot be silently dropped.
 f=fixture();f.fires.push({...shot(5.6),weapon:'rpg'});f.blood.push(blood(2,5.6));r=await B.match(f);
 assert.equal(r.rows.ac.conc.identified,0);
 // Visibility filtering happens after assignment; it cannot manufacture uniqueness.
 f=fixture();f.combat.pop();f.shotVisibility=s=>({state:s.t===5?'visible':'not-visible',targets:[2]});
 r=await B.match(f);assert.equal(r.rows.ac.conc.fired,1);assert.equal(r.rows.ac.conc.identified,0);
 f=fixture();f.withinMargin=()=>true;r=await B.match(f);
 assert.equal(r.rows.ac.conc.inclusive,2);assert.equal(r.rows.ac.conc.plausibleAdditional,0);checkUnique(r);
 console.log('PASS: distinct blood timing, interchangeable log rows, insufficient capacity, per-shot deduplication, competing shots, explosions, missing/overlapping victims, projectile competitors, visibility and inclusive accounting');
})().catch(e=>{console.error(e);process.exitCode=1});

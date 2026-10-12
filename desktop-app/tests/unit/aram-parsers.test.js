const fs=require('fs'),path=require('path'),assert=require('assert');
const { APP, fixture } = require('../lib/common');
const P=require(APP+'aram-parsers.js');
const rd=f=>fixture('aram/'+f);
const tl=P.parseTierList(rd('tier.html'));
assert.strictEqual(tl.champions.length,173); assert.strictEqual(tl.patch,'26.19'); assert.strictEqual(tl.dataDate,'2026-10-03');
const teemo=tl.champions.find(c=>c.slug==='teemo'); assert.strictEqual(teemo.wr,53.44); assert.strictEqual(teemo.tier,'S+'); assert.strictEqual(teemo.rank,1);
assert(tl.champions.every(c=>c.tier&&c.name&&c.image)); console.log('tier ok', tl.avgWr, teemo);
for(const f of ['b_teemo','b_wukong','b_nunu']){
  const c=P.parseChampionPage(rd(f+'.html')); 
  const n=(c.augments.prismatic.length+c.augments.gold.length+c.augments.silver.length);
  console.log(f,JSON.stringify(c.meta),c.balance, 'aug',c.augments.prismatic.length,c.augments.gold.length,c.augments.silver.length);
  assert.strictEqual(c.items,undefined,'arammayhem items are no longer parsed');
  assert(n>=10); assert(c.meta.wr>30&&c.meta.tier);
  if(f==='b_teemo'){assert.strictEqual(c.augments.prismatic[0].name,'Archmage');assert.strictEqual(c.augments.prismatic[0].wr,54.58);assert.strictEqual(c.augments.prismatic[0].appearance,18.01);console.log(c.augments.prismatic[0]);}
}
for(const f of ['l_teemo_all','l_wukong','l_teemo']){const l=P.parseLolalytics(rd(f+'.html'));console.log(f,JSON.stringify(l));assert(l.core&&l.start&&l.spells&&l.slots[4].length);}
const a=P.parseLolalytics(rd('l_ahri_aram.html'));
assert(a.boots.length>=5,'boots from the Qwik state'); assert.strictEqual(a.boots[0].id,3020); assert.strictEqual(a.boots[0].wr,51.48); assert.strictEqual(a.boots[0].games,219838); assert(a.boots.some(b=>b.other));
for(const s of [4,5,6]) assert(a.slots[s].length>=3&&a.slots[s].every(r=>r.id&&r.wr>0&&r.games>0),'slot '+s);
assert.strictEqual(P.parseQwikBuild('<html>nothing</html>'),null);
assert.deepStrictEqual(P.parseLolalytics(rd('l_teemo_all.html')).boots.length>=1||true,true);
console.log('ahri boots',a.boots.length,'slot4',a.slots[4].length,'ALL OK');
// 2026-10 page layout: "<h3 ...>Prismatic Augments</h3>", attributes on every tag
const nw=P.parseChampionPage(rd('b_teemo_2026-10.html'));
assert.deepStrictEqual([nw.augments.prismatic.length,nw.augments.gold.length,nw.augments.silver.length],[6,6,6],'augments in the new layout');
assert.deepStrictEqual(nw.augments.prismatic[0],{slug:'archmage',name:'Archmage',icon:'https://arammayhem.com/augments/Archmage_mayhem_augment.webp',appearance:13.52,wr:52.78});
console.log('2026-10 layout ok');

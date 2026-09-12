import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const names=['getPlatformStageRect','projectAudiencePoint','projectAudiencePoint3D','buildPlatformAudienceTopDepthSlices','buildPlatformAudienceTopGridDepthItems','getPlatformTopGridSegments','buildPlatformAudienceTopOutlineDepthItems','buildPlatformAudienceTopStructureDepthItems','sortAudienceDepthMergedItems','audienceDepthMergeItemY','resolveOwnPlatformStructureDepthTieBreak','resolveLateralStairsPlatformTieBreak','getPlacementSurfaceId'];
const constants=['PLATFORM_MIN_SIZE','UNIT_CM','PERSPECTIVE','AUDIENCE_PLATFORM_TOP_SLICE_DEPTH','AUDIENCE_PLATFORM_TOP_SLICE_MAX_COUNT','AUDIENCE_DEPTH_MERGE_TIE_EPSILON','LATERAL_STAIRS_PLATFORM_TIE_EPSILON'];
const code=constants.map(n=>source.match(new RegExp(`const ${n} = [\\s\\S]*?;`))[0]).join('\n')+'\n'+names.map(n=>source.match(new RegExp(`function ${n}\\([^]*?\\n\\}(?=\\n)`))[0]).join('\n');
const h=vm.runInNewContext(`${code}\n({${names.join(',')}})`,{clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),lerp:(a,b,t)=>a+(b-a)*t});
const platform={id:'p',x:0,y:5,width:4,depth:2,height:4};
const bounds={minX:-900,maxX:900,totalH:1000,bottomMargin:100,leftMargin:100};
const args={platform,bounds,stageDepth:10,stageGuide:{gridVertical:[{x1:0}],gridHorizontal:[{y1:5}]}};
const items=()=>h.buildPlatformAudienceTopStructureDepthItems(args);
const outlines=()=>items().filter(i=>i.kind==='platform-top-outline-line');
const rear=()=>outlines().find(i=>i.edge==='rear');
const person=(y,surfaceId=null)=>({kind:'performer',key:'person',depthY:y,pos:{y,surfaceId}});
const sort=items=>h.sortAudienceDepthMergedItems(items).map(i=>i.key);
test('rear projects exact yMax endpoints at platform height',()=>{
 const r=rear();expect(r.depthY).toBe(6);expect(r.platformId).toBe('p');
 expect(r.a).toEqual(h.projectAudiencePoint3D(bounds,10,-2,6,4));expect(r.b).toEqual(h.projectAudiencePoint3D(bounds,10,2,6,4));
});
test('front is not duplicated and keys are unique',()=>{
 expect(outlines().some(i=>i.edge==='front')).toBe(false);expect(new Set(items().map(i=>i.key)).size).toBe(items().length);
});
test('side segments share existing strip vertices and depths',()=>{
 const strips=items().filter(i=>i.kind==='platform-top-strip');const side=outlines().filter(i=>i.edge!=='rear');
 expect(side).toHaveLength(2*strips.length);
 strips.forEach((s,i)=>{expect(side[i*2]).toMatchObject({depthY:s.depthY,a:s.points[0],b:s.points[3]});expect(side[i*2+1]).toMatchObject({depthY:s.depthY,a:s.points[1],b:s.points[2]});});
});
test('outline addition preserves strip and grid outputs exactly',()=>{
 const strips=h.buildPlatformAudienceTopDepthSlices(args);
 const grid=h.buildPlatformAudienceTopGridDepthItems({...args,stripBoundaries:strips.map(s=>({y0:s.y0,y1:s.y1}))});
 expect(items().filter(i=>i.kind!=='platform-top-outline-line')).toEqual([...strips,...grid]);
});
for(const [y,expected] of [[7,['person','p-outline-rear']],[5,['p-outline-rear','person']],[6,['p-outline-rear','person']]]) test(`rear vs performer y=${y}`,()=>expect(sort([rear(),person(y)])).toEqual(expected));
test('own platform performer renders after rear even when further back',()=>expect(sort([person(7,'p'),rear()])).toEqual(['p-outline-rear','person']));
test('multiple platforms have independent rear depths',()=>{
 const other=h.buildPlatformAudienceTopStructureDepthItems({...args,platform:{...platform,id:'q',y:9}}).find(i=>i.edge==='rear');
 expect(sort([rear(),other,person(8)])).toEqual(['q-outline-rear','person','p-outline-rear']);
});
test('side lines follow their fill at equal depth',()=>{
 const sorted=h.sortAudienceDepthMergedItems(items());
 for(const strip of sorted.filter(i=>i.kind==='platform-top-strip'))for(const line of sorted.filter(i=>i.edge!=='rear'&&i.kind==='platform-top-outline-line'&&i.depthY===strip.depthY))expect(sorted.indexOf(line)).toBeGreaterThan(sorted.indexOf(strip));
});
test('height changes projection only',()=>{
 const r=h.buildPlatformAudienceTopStructureDepthItems({...args,platform:{...platform,height:8}}).find(i=>i.edge==='rear');expect(r.depthY).toBe(rear().depthY);expect(r.a.sy).toBeLessThan(rear().a.sy);
});
test('lateral tie applies to outline, with two-platform safeguard',()=>{
 const stair={kind:'stairs-tread',key:'stairs',depthKey:5.995,lateral:true,connectedPlatformIds:['p'],hasTwoPlatformEndpoints:false};
 expect(sort([rear(),stair])).toEqual(['stairs','p-outline-rear']);
 expect(sort([rear(),{...stair,hasTwoPlatformEndpoints:true}])).toEqual(['p-outline-rear','stairs']);
});
test('Beam vs performer tie remains unchanged with outline present',()=>expect(sort([person(5),{kind:'beamSlice',key:'beam',depthY:5},rear()])).toEqual(['p-outline-rear','beam','person']));
test('invalid outline input is safe',()=>expect(h.buildPlatformAudienceTopOutlineDepthItems({...args,platform:null,strips:[]})).toEqual([]));
test('Screen and Canvas use the same kind inside depth rendering',()=>{
 expect(source.match(/if \(item.kind === "platform-top-grid-line" \|\| item.kind === "platform-top-outline-line"\)/g)).toHaveLength(2);
 expect(source).toContain('ctx.globalAlpha = isOutline ? 1 : 0.5;');expect(source).toContain('strokeOpacity={isOutline ? 1 : 0.5}');
});

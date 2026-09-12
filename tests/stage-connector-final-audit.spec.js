import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const roots=['buildFormationExportModel','resolveLightingBeams3DForDisplay','resolvePlacementEffectiveSurfaceHeight','buildAudienceTrajectoryScreenPoints','interpolatePlacementsWithPaths','computeZones','getAudiencePerformerDisplayMode','getStageConnectorAudienceDisplayMode','resolveLightingBeam3DEffectiveTarget','buildLightingCueExportModels'];
const functions=new Map([...source.matchAll(/^function (\w+)\([^]*?\n\}(?=\n)/gm)].map(m=>[m[1],m[0]]));
const constants=new Map([...source.matchAll(/^const ([A-Z][A-Z_0-9]*) = [^]*?;/gm)].map(m=>[m[1],m[0]]));
const selected=new Map();
function include(name){if(selected.has(name))return;const code=functions.get(name)||constants.get(name);if(!code)return;selected.set(name,code);for(const word of code.replace(/\/\*[^]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').match(/\b\w+\b/g)||[])if(word!==name)include(word);}
roots.forEach(include);
const h=vm.runInNewContext([...selected.values()].sort((a,b)=>source.indexOf(a)-source.indexOf(b)).join('\n')+`\n({${roots.join(',')}})`,{clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),lerp:(a,b,t)=>a+(b-a)*t});
const stage={width:20,depth:10};const zones=h.computeZones(stage);
const platforms=[{id:'p',x:0,y:8,width:4,depth:4,height:4}];
const c={id:'stairs',type:'stairs',x:0,y:4,width:2,depth:4,facing:'upstage',fromSurfaceId:null,toSurfaceId:'p'};
const pos=(x,y,patch={})=>({x,y,area:'stage',surfaceMode:'auto',surfaceId:null,...patch});
const z=(p,cs=[c])=>h.resolvePlacementEffectiveSurfaceHeight(p,platforms,cs);
for(const [label,p,want] of [['floor',pos(5,1),0],['platform',pos(0,8,{surfaceId:'p'}),4],['stairs midpoint',pos(0,4),2],['manual ignores stairs',pos(0,4,{surfaceMode:'manual'}),0]])test(label,()=>expect(z(p)).toBe(want));
for(const facing of ['upstage','downstage','stageLeft','stageRight'])test(`${facing} continuous stairs endpoints and midpoint`,()=>{
 const cc={...c,facing,width:4};const points=facing==='upstage'?[pos(0,2),pos(0,4),pos(0,6)]:facing==='downstage'?[pos(0,6),pos(0,4),pos(0,2)]:facing==='stageLeft'?[pos(2,4),pos(0,4),pos(-2,4)]:[pos(-2,4),pos(0,4),pos(2,4)];
 expect(points.map(p=>z(p,[cc]))).toEqual([0,2,4]);
});
test('platform to platform interpolates endpoint heights',()=>{
 expect(h.resolvePlacementEffectiveSurfaceHeight(pos(0,4),[...platforms,{id:'q',height:2}],[{...c,fromSurfaceId:'q'}])).toBe(3);
});
for(const area of ['stageLeft','stageRight','upstageBackstage'])test(`${area} ghost policy and stairs height`,()=>{
 const p=pos(0,4,{area});expect(h.getAudiencePerformerDisplayMode(p,true)).toBe('ghost');expect(h.getAudiencePerformerDisplayMode(p,false)).toBe('hidden');expect(z(p)).toBe(2);
});
test('outside lateral ghost stairs still provides continuous Z',()=>{
 const cc={...c,x:12,width:2,facing:'stageRight'};expect(h.getStageConnectorAudienceDisplayMode(cc,stage)).toBe('ghost');expect(z(pos(12,4,{area:'stageRight'}),[cc])).toBe(2);
});
const bounds={minX:-900,maxX:900,totalH:1000,bottomMargin:100,leftMargin:100};
for(const [name,config] of [['straight',null],['curve',{a:{type:'curve',waypoint:{x:0.5,y:4}}}]])test(`${name} trajectory matches actual interpolated placements at every sample`,()=>{
 const from=pos(0,2),to=pos(0,6);const points=h.buildAudienceTrajectoryScreenPoints('a',from,to,config,platforms,zones,[c],bounds,10);
 expect(points.length).toBeGreaterThan(2);
 // The same helper with an exact progress supplies the corresponding sampled endpoint.
 for(const progress of [0,0.5,1]){
  const placement=h.interpolatePlacementsWithPaths({a:from},{a:to},progress,config,null,platforms,zones).a;
  expect(z(placement)).toBeCloseTo(4*progress);
  const partial=h.buildAudienceTrajectoryScreenPoints('a',from,to,config,platforms,zones,[c],bounds,10,progress);
  expect(points[Math.round(progress*(points.length-1))]).toEqual(partial.at(-1));
 }
});
test('Beam follow shares continuous stairs Z; omitted connectors retains fallback',()=>{
 const p=pos(0,4);expect(z(p)).toBe(2);
 expect(h.resolveLightingBeams3DForDisplay([{followPerformerId:'a',target:{x:0,y:0,z:0}}],{a:p},platforms,[c])[0].target.z).toBe(2);
 expect(h.resolveLightingBeam3DEffectiveTarget({followPerformerId:'a',target:{x:0,y:0,z:0}},{a:p},platforms).z).toBe(0);
});
for(const curve of [false,true])test(`actual Cue model retains full trajectory inputs at start/middle/end, curve=${curve}`,()=>{
 const from=pos(0,2),to=pos(0,6,{surfaceId:'p'});const slide={id:'s',placements:{a:from},keepCounts:4},next={id:'n',placements:{a:to}};
 const config=curve?{a:{type:'curve',waypoint:{x:0.5,y:4}}}:null;
 const cuts=h.buildLightingCueExportModels({slide,slideIndex:0,slides:[slide,next],performers:[{id:'a',height:170}],stage,zones,musicSections:[],transitionCounts:{s:4},effectiveTransitionPathConfig:{s:config},platforms,stageConnectors:[c],showTrajectory:true,trajectoryMode:'next',showLightingTrackingPaths:false,lightingScenes:[{slideId:'s',enabled:true,areas:[],beams3D:[followBeam],cues:[]}],transitionLightingCues:{s:[0,2,4].map(count=>({id:`c${count}`,count,areas:[],beams3D:[followBeam]}))}});
 const transition=cuts.filter(cut=>cut.trajectoryProgress!==undefined).slice(-3);
 expect(transition).toHaveLength(3);
 transition.forEach((cut,i)=>{
  expect(cut.trajectoryProgress).toBe(i/2);expect(z(cut.placements.a)).toBeCloseTo(2*i);
  expect(cut.trajectoryFromPlacements.a).toEqual(from);expect(cut.trajectoryToPlacements.a).toEqual(to);
  expect(cut.stageConnectors).toEqual([c]);
  expect(cut.lightingBeams3D[0].target).toEqual({x:cut.placements.a.x,y:cut.placements.a.y,z:z(cut.placements.a)});
  const points=h.buildAudienceTrajectoryScreenPoints('a',cut.trajectoryFromPlacements.a,cut.trajectoryToPlacements.a,cut.trajectoryPathConfig,platforms,zones,[c],bounds,10);
  expect(points).toEqual(h.buildAudienceTrajectoryScreenPoints('a',from,to,config,platforms,zones,[c],bounds,10));
 });
});
test('existing workspace save/load retains work data without browser storage',()=>{
 const store=new Map();const localStorage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
 const code=['saveWorkspace','loadWorkspace','normalizeWorkspace','migrateWorkspace'].map(n=>functions.get(n)).join('\n');
 const api=vm.runInNewContext(`${code}\n({saveWorkspace,loadWorkspace})`,{window:{localStorage},WORKSPACE_VERSION:1,WORKSPACE_STORAGE_KEY:'audit',makeId:()=> 'generated',createFreshWorkspace:()=>({projects:[]})});
 const work={stage,platforms,stageConnectors:[c],slides:[{id:'s',placements:{a:pos(0,4)}}],lightingScenes:[{id:'l',areas:[],beams3D:[]}],transitionPaths:{s:{a:{type:'curve',waypoint:{x:1,y:4}}}}};
 expect(api.saveWorkspace({version:1,activeProjectId:'project',projects:[{id:'project',name:'Audit',work}]})).toBe(true);
 expect(api.loadWorkspace().projects[0].work).toEqual(work);
});
// Lighting Phase L1: exercise the shared display resolver with actual placements.
const followBeam={id:'follow',followPerformerId:'a',source:{x:1,y:1,z:20},target:{x:9,y:9,z:9},targetSurfaceMode:'manual',targetSurfaceId:'saved',sourceWidth:2,targetWidth:3,intensity:0.7,color:'#ff0000',opacity:0.4};
function target(p,cs=[c],ps=platforms){return h.resolveLightingBeams3DForDisplay([followBeam],{a:p},ps,cs)[0].target;}
for(const progress of [0.25,0.5,0.75])test(`L1 stairs ${progress}: current XY and continuous Z`,()=>{
 const p=h.interpolatePlacementsWithPaths({a:pos(0,2)},{a:pos(0,6,{surfaceId:'p'})},progress,null,null,platforms,zones).a;
 expect(target(p)).toEqual({x:p.x,y:p.y,z:z(p)});expect(target(p).z).toBe(4*progress);
});
for(const area of ['stage','stageLeft','stageRight','upstageBackstage'])test(`L1 ${area} auto follows physical stairs`,()=>expect(target(pos(0,4,{area})).z).toBe(2));
for(const surfaceId of [null,'p'])test(`L1 manual surface ${surfaceId} ignores stairs`,()=>{
 const p=pos(0,4,{surfaceMode:'manual',surfaceId});expect(target(p).z).toBe(z(p));expect(target(p).z).toBe(surfaceId?4:0);
});
for(const [fromId,toId,fromHeight,toHeight] of [[null,'p',0,4],['p',null,4,0],['p','q',5,12],['q','p',12,5]])test(`L1 endpoints ${fromHeight} to ${toHeight}`,()=>{
 const ps=[{...platforms[0],height:fromId==='p'?fromHeight:toHeight},{id:'q',height:fromId==='q'?fromHeight:toHeight}];
 const cc={...c,fromSurfaceId:fromId,toSurfaceId:toId};const p=pos(0,4);
 expect(target(p,[cc],ps).z).toBe((fromHeight+toHeight)/2);
});
for(const [name,waypoint,want] of [['through',{x:0.5,y:4},2],['avoid',{x:8,y:4},0]])test(`L1 curve ${name} uses actual XY`,()=>{
 const p=h.interpolatePlacementsWithPaths({a:pos(0,2)},{a:pos(0,6,{surfaceId:'p'})},0.5,{a:{type:'curve',waypoint}},null,platforms,zones).a;
 expect(target(p)).toEqual({x:p.x,y:p.y,z:z(p)});expect(target(p).z).toBe(want);
});
test('L1 modifies target only and leaves stored beam/placement unchanged',()=>{
 const p=pos(0,4);const before=JSON.stringify({followBeam,p});const result=h.resolveLightingBeams3DForDisplay([followBeam],{a:p},platforms,[c])[0];
 expect({...result,target:followBeam.target}).toEqual(followBeam);expect(result.source).toBe(followBeam.source);expect(JSON.stringify({followBeam,p})).toBe(before);
});
test('L1 missing follow target and fixed Beam retain original semantics',()=>{
 const fixed={...followBeam,followPerformerId:null,targetSurfaceId:null};
 expect(h.resolveLightingBeams3DForDisplay([fixed],{},platforms,[c])[0].target).toEqual(fixed.target);
 expect(h.resolveLightingBeams3DForDisplay([followBeam],{},platforms,[c])[0].target.z).toBe(9);
});
test('L1 actual display regression: old resolver gives 0, new resolver gives performer Z=2',()=>{
 const oldCode=[...selected.values()].sort((a,b)=>source.indexOf(a)-source.indexOf(b)).join('\n').replace('z: resolvePlacementEffectiveSurfaceHeight(pos, platforms, stageConnectors)','z: resolvePlacementSurfaceHeight(pos, platforms)');
 const oldDisplay=vm.runInNewContext(`${oldCode}\nresolveLightingBeams3DForDisplay`,{clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),lerp:(a,b,t)=>a+(b-a)*t});
 const p=pos(0,4);expect(oldDisplay([followBeam],{a:p},platforms,[c])[0].target.z).toBe(0);expect(target(p).z).toBe(z(p));expect(z(p)).toBe(2);
});
test('L1 Formation Export uses the same stairs-aware display target',()=>{
 const p=pos(0,4),slide={id:'s',placements:{a:p}};
 const model=h.buildFormationExportModel({slide,slideIndex:0,slides:[slide],performers:[{id:'a',height:170}],stage,zones,musicSections:[],transitionCounts:{},platforms,stageConnectors:[c],showTrajectory:false,lightingEnabled:true,lightingScenes:[{slideId:'s',enabled:true,beams3D:[followBeam],areas:[]}]});
 expect(model.lightingBeams3D[0].target).toEqual(target(p));
});

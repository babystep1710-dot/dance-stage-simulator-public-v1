import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const names=['resolvePlacementEffectiveSurfaceHeight','getPlacementSurfaceMode','resolveStageConnectorHeightAtPointFromList','getLightingBeam3DTargetSurfaceMode','isLightingBeam3DDirectionFlipDisabled',
 'createDefaultLightingBeam3D','getLightingBeam3DTargetSurfaceId','resolveLightingBeam3DTargetSurfaceHeight',
 'resolveLightingBeam3DTarget','resolveLightingBeam3DEffectiveTarget','resolveLightingBeams3DForDisplay',
 'resolvePlatformAtPoint','getPlatformStageRect','getPlacementSurfaceId','resolvePlacementSurfaceHeight',
 'getLightingBeam3DPositionMoveCounts','getLightingBeam3DPositionMoveMode','getLightingBeamLogicalId','findMatchingLightingBeam',
 'interpolateLightingBeam3DPositionState','resolveBoundaryMoveArrivingBeams',
 'cloneLightingStateSnapshot','cloneLightingItemDataByType','remapLightingStateForCrossFormationPaste',
 'interpolateLightingIntensityState','resolveLightingCueState','interpolateLightingAreaPositionState',
 'getLightingAreaPositionMoveCounts','findMatchingLightingArea','getLightingAreaLogicalId',
 'cloneLightingSceneContentForSlide','getLightingAreas','getLightingBeams','getLightingBeams3D','getLightingSceneCues',
 'lightingAreaColorHex','parseHexColorToRgb','rgbToHexColor','interpolateLightingColor'];
const constants=['PLATFORM_MIN_SIZE','DEFAULT_LIGHTING_BEAM_3D_INTENSITY','DEFAULT_LIGHTING_BEAM_3D_SOURCE_WIDTH',
 'DEFAULT_LIGHTING_BEAM_3D_TARGET_WIDTH','LIGHTING_BEAM_3D_MIN_Z','LIGHTING_BEAM_3D_MAX_Z','LIGHTING_AREA_POSITION_MOVE_MODES',
 'LIGHTING_AREA_COLOR_PRESETS'];
const code=constants.map(n=>source.match(new RegExp(`const ${n} = [\\s\\S]*?;`))[0]).join('\n')+'\n'+
 names.map(n=>source.match(new RegExp(`function ${n}\\([^]*?\\n\\}`))[0]).join('\n');
const context=vm.createContext({});
const h=vm.runInContext(`const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));const lerp=(a,b,t)=>a+(b-a)*t;let serial=0;const makeId=p=>p+(++serial);${code}\n({${names.join(',')}})`,context);
const platform={id:'p',x:0,y:5,width:2,depth:2,height:8};
const beam=(patch={})=>({id:'b',logicalBeamId:'l',source:{x:0,y:0,z:20},target:{x:0,y:5,z:3},targetSurfaceId:'saved',targetSurfaceMode:'auto',intensity:1,...patch});
const z=(b,platforms=[platform],placements={})=>h.resolveLightingBeams3DForDisplay([b],placements,platforms)[0].target.z;
for(const mode of [undefined,null,'invalid',false,0]) test(`legacy/invalid mode ${mode} is manual`,()=> {
 expect(h.getLightingBeam3DTargetSurfaceMode({targetSurfaceMode:mode})).toBe('manual');
 expect(z(beam({targetSurfaceMode:mode,targetSurfaceId:null}))).toBe(3);
});
test('new Beam starts auto, preserves stored target defaults',()=> {
 const b=h.createDefaultLightingBeam3D({width:20,depth:10});
 expect(b.targetSurfaceMode).toBe('auto');expect(b.targetSurfaceId).toBe(null);expect(b.target.z).toBe(0);
});
test('manual Phase 3A explicit and deleted surfaces',()=> {
 expect(z(beam({targetSurfaceMode:'manual',targetSurfaceId:'p'}))).toBe(8);
 expect(z(beam({targetSurfaceMode:'manual',targetSurfaceId:'deleted'}))).toBe(3);
 expect(z(beam({targetSurfaceMode:'manual',targetSurfaceId:null}))).toBe(3);
});
test('auto stage/high platform ignores saved ID and z',()=> {
 expect(z(beam(),[])).toBe(0);expect(z(beam())).toBe(8);
});
for(const [x,y] of [[-1,4],[1,6],[0,4],[1,5]]) test(`inclusive platform boundary ${x},${y}`,()=>expect(z(beam({target:{x,y,z:3}}))).toBe(8));
test('overlap uses greatest height and array order on ties',()=> {
 const high={...platform,id:'high',height:12};expect(z(beam(),[platform,high])).toBe(12);
 expect(h.resolvePlatformAtPoint(0,5,[platform,{...platform,id:'second'}]).id).toBe('p');
});
for(const target of [null,{x:NaN,y:5},{x:0,y:Infinity},{x:'0',y:5},{}]) test(`invalid coordinates ${JSON.stringify(target)}`,()=>expect(h.resolveLightingBeam3DTargetSurfaceHeight(beam({target}),[platform])).toBe(0));
test('invalid/zero/negative platform heights are safe',()=> {
 for(const height of [NaN,Infinity,0,-1]) expect(z(beam(),[{...platform,height}])).toBe(0);
});
test('same frozen Beam responds to platform add/move/resize/height/delete',()=> {
 const b=beam();Object.freeze(b.target);Object.freeze(b);const before=JSON.stringify(b);
 expect(z(b,[])).toBe(0);expect(z(b)).toBe(8);
 expect(z(b,[{...platform,x:4}])).toBe(0);
 expect(z(b,[{...platform,x:4,width:10}])).toBe(8);
 expect(z(b,[{...platform,height:20}])).toBe(20);expect(z(b,[])).toBe(0);
 expect(JSON.stringify(b)).toBe(before);expect(b.target.z).toBe(3);expect(b.targetSurfaceId).toBe('saved');
});
for(const mode of ['auto','manual']) test(`follow priority, missing follow and release ${mode}`,()=> {
 const b=beam({targetSurfaceMode:mode,targetSurfaceId:null,followPerformerId:'actor'});
 const p={actor:{x:20,y:5,area:'stage'}};
 expect(z(b,[platform],p)).toBe(0);
 expect(z(b,[platform],{actor:{x:20,y:5,area:'stage',surfaceId:'p'}})).toBe(8);
 expect(z(b)).toBe(mode==='auto'?8:3);
 expect(z({...b,followPerformerId:null})).toBe(mode==='auto'?8:3);
 expect(b.targetSurfaceMode).toBe(mode);
});
for(const kind of ['cue','boundary']) test(`${kind} Move uses interpolated target and from mode`,()=> {
 const from=beam({target:{x:-4,y:5,z:3}}),to=beam({target:{x:4,y:5,z:9},targetSurfaceMode:'manual',positionMoveCounts:4,positionMoveMode:'transition'});
 const resolve=t=>kind==='cue'?h.interpolateLightingBeam3DPositionState([from],[to],t,4,0):h.resolveBoundaryMoveArrivingBeams([to],[from],4,t,0);
 expect(z(resolve(0)[0])).toBe(0);const mid=resolve(2)[0];expect(mid.target.x).toBe(0);expect(mid.target.z).toBe(6);expect(mid.targetSurfaceMode).toBe('auto');expect(z(mid)).toBe(8);
 expect(z(resolve(4)[0])).toBe(0);
});
test('Cue mode switches discretely at cue count',()=> {
 const from=beam(),to=beam({targetSurfaceMode:'manual',targetSurfaceId:null});
 for(const t of [0,1.99,2]) {
 const state=h.resolveLightingCueState({baseAreas:[],baseBeams3D:[from],cues:[{id:'cue',count:2,fadeCounts:1,areas:[],beams3D:[to]}],elapsedCounts:t});
 expect(state.beams3D[0].targetSurfaceMode).toBe(t<2?'auto':'manual');expect(z(state.beams3D[0])).toBe(t<2?8:3);
 }
});
test('Fade preserves mode for both, from-only and to-only',()=> {
 const from=beam(),to=beam({targetSurfaceMode:'manual',intensity:0});
 expect(h.interpolateLightingIntensityState([], [from], [], [to],0.5).beams3D[0]).toMatchObject({targetSurfaceMode:'auto',intensity:0.5});
 expect(h.interpolateLightingIntensityState([], [from], [], [],0.5).beams3D[0].targetSurfaceMode).toBe('auto');
 expect(h.interpolateLightingIntensityState([], [], [], [to],0.5).beams3D[0].targetSurfaceMode).toBe('manual');
});
// 照明フェード v1.2：same-idはcolorも連続補間するが、from-only/to-onlyは従来通りcolorに
// 一切触れない（保存されたpreset keyのままfromまたはtoの値を維持する）ことを確認する。
function midHex(fromHex,toHex,t) {
 const fv=parseInt(fromHex.slice(1),16),tv=parseInt(toHex.slice(1),16);
 const fr=(fv>>16)&255,fg=(fv>>8)&255,fb=fv&255,tr=(tv>>16)&255,tg=(tv>>8)&255,tb=tv&255;
 const mix=(a,b)=>Math.round(a+(b-a)*t).toString(16).padStart(2,'0');
 return `#${mix(fr,tr)}${mix(fg,tg)}${mix(fb,tb)}`;
}
test('Fade color: same-id interpolates, from-only/to-only keep original preset key',()=> {
 const from=beam({color:'white',intensity:1}),to=beam({color:'blue',intensity:1});
 expect(h.interpolateLightingIntensityState([],[from],[],[to],0.5).beams3D[0]).toMatchObject({color:midHex('#ffffff','#4d7cff',0.5),intensity:1});
 expect(h.interpolateLightingIntensityState([],[from],[],[],0.5).beams3D[0].color).toBe('white'); // from-only：fromのpreset keyのまま
 expect(h.interpolateLightingIntensityState([],[],[],[to],0.5).beams3D[0].color).toBe('blue'); // to-only：toのpreset keyのまま
});
test('Fade color+intensity: same-id changes both together (white/30% -> blue/100%)',()=> {
 const from=beam({color:'white',intensity:0.3}),to=beam({color:'blue',intensity:1});
 const result=h.interpolateLightingIntensityState([],[from],[],[to],0.5).beams3D[0];
 expect(result.intensity).toBeCloseTo(0.65,5);
 expect(result.color).toBe(midHex('#ffffff','#4d7cff',0.5));
});
test('snapshot and same/cross Formation clipboard preserve mode without derived z',()=> {
 const b=beam();
 const copies=[h.cloneLightingStateSnapshot([],[b]).beams3D[0],h.cloneLightingItemDataByType('beam3D',b),h.remapLightingStateForCrossFormationPaste([],[b]).beams3D[0]];
 for(const copy of copies){expect(copy.targetSurfaceMode).toBe('auto');expect(copy.targetSurfaceId).toBe('saved');expect(copy.target.z).toBe(3);expect(copy.target).not.toBe(b.target);}
});
test('Formation clone retains mode in Base and Cue',()=> {
 const b=beam();const sc=h.cloneLightingSceneContentForSlide({enabled:true,areas:[],beams3D:[b],cues:[{id:'cue',count:2,areas:[],beams3D:[b]}]},'new');
 expect(sc.beams3D[0].targetSurfaceMode).toBe('auto');expect(sc.cues[0].beams3D[0].targetSurfaceMode).toBe('auto');
});
for(const [label,patch,disabled] of [['auto',{},true],['manual',{targetSurfaceMode:'manual',targetSurfaceId:null},false],['platform',{targetSurfaceMode:'manual',targetSurfaceId:'p'},true],['follow',{targetSurfaceMode:'manual',targetSurfaceId:null,followPerformerId:'actor'},true]])
 test(`flip guard ${label}`,()=>expect(h.isLightingBeam3DDirectionFlipDisabled(beam(patch))).toBe(disabled));

function callback(name, extras) {
 const match=source.match(new RegExp(`const ${name} = useCallback\\(\\s*([^]*?),\\s*\\[commitWork, activeLightingCueSelectionForEdit, isEditingNextFormationLightingBase\\]\\s*\\);`));
 return vm.runInContext(`(${match[1]})`,vm.createContext({...context,isEditingNextFormationLightingBase:false,activeLightingCueSelectionForEdit:null,...extras}));
}
test('surface commit is one update and auto preserves stored fields',()=> {
 let state=beam({targetSurfaceMode:'manual'}),commits=0;
 const run=callback('setLightingBeam3DTargetSurfaceCommit',{
  commitWork:fn=>{commits++;state=fn(state);},resolveActiveLightingTargetSlideId:()=> 'slide',
  applyActiveLightingUpdate:(prev,slide,cue,type,id,patch)=>({...prev,...patch}),
 });
 run('b','__auto__');expect(commits).toBe(1);expect(state).toMatchObject({targetSurfaceMode:'auto',targetSurfaceId:'saved',target:{z:3}});
 run('b','p');expect(commits).toBe(2);expect(state).toMatchObject({targetSurfaceMode:'manual',targetSurfaceId:'p',target:{z:3}});
 run('b','');expect(commits).toBe(3);expect(state).toMatchObject({targetSurfaceMode:'manual',targetSurfaceId:null,target:{z:3}});
});
test('actual duplicate handler retains mode and saved target fields',()=> {
 const b=beam();let copied;
 const run=callback('duplicateLightingBeam3D',{
  makeId:prefix=>prefix+'-new',commitWork:fn=>fn({}),resolveActiveLightingTargetSlideId:()=> 'slide',
  readActiveLightingLists:()=>({areas:[],beams3D:[b]}),
  writeActiveLightingLists:(prev,slide,cue,areas,beams)=>{copied=beams[1];return prev;},
  setSelectedLightingBeam3DId:()=>{},setSelectedLightingItemKeys:()=>{},
 });
 run('b');expect(copied).toMatchObject({targetSurfaceMode:'auto',targetSurfaceId:'saved',target:{z:3}});
 expect(copied.target).not.toBe(b.target);
});

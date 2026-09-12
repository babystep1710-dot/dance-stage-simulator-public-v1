import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const names=['getLightingAreaSurfaceMode','getLightingAreaSurfaceId','resolveLightingAreaSurfaceHeight','createDefaultLightingArea',
 'resolvePlatformAtPoint','getPlatformStageRect','getLightingAreaStagePoints','rotatePointAroundCenter',
 'getLightingAreaPositionMoveMode','getLightingAreaPositionMoveCounts','getLightingAreaLogicalId','findMatchingLightingArea',
 'interpolateLightingAreaPositionState','resolveBoundaryMoveArrivingAreas','interpolateLightingIntensityState','resolveLightingCueState',
 'interpolateLightingBeam3DPositionState','findMatchingLightingBeam','getLightingBeamLogicalId','getLightingBeam3DPositionMoveCounts',
 'cloneLightingStateSnapshot','cloneLightingItemDataByType','remapLightingStateForCrossFormationPaste','cloneLightingSceneContentForSlide',
 'getLightingAreas','getLightingBeams','getLightingBeams3D','getLightingSceneCues','findLightingSceneBySlideId',
 'projectAudiencePoint','projectAudiencePoint3D'];
const constants=['PLATFORM_MIN_SIZE','LIGHTING_AREA_MIN_SIZE','LIGHTING_AREA_MAX_SIZE','DEFAULT_LIGHTING_AREA_WIDTH',
 'DEFAULT_LIGHTING_AREA_HEIGHT','DEFAULT_LIGHTING_AREA_INTENSITY','LIGHTING_AREA_POSITION_MOVE_MODES','LIGHTING_AREA_ELLIPSE_SEGMENTS','UNIT_CM','PERSPECTIVE'];
const code=constants.map(n=>source.match(new RegExp(`const ${n} = [\\s\\S]*?;`))[0]).join('\n')+'\n'+names.map(n=>source.match(new RegExp(`function ${n}\\([^]*?\\n\\}`))[0]).join('\n');
const h=vm.runInNewContext(`const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));const lerp=(a,b,t)=>a+(b-a)*t;let serial=0;const makeId=p=>p+(++serial);${code}\n({${names.join(',')}})`);
const pl={id:'p',x:0,y:5,width:2,depth:2,height:8};
const area=(patch={})=>({id:'a',logicalAreaId:'l',x:0,y:5,width:10,height:6,rotation:30,shape:'ellipse',intensity:1,surfaceMode:'auto',surfaceId:'saved',...patch});
const z=(a,platforms=[pl])=>h.resolveLightingAreaSurfaceHeight(a,platforms);
for(const mode of [undefined,null,'bad',false,0]) test(`legacy mode ${mode} remains manual`,()=> {
 expect(h.getLightingAreaSurfaceMode({surfaceMode:mode})).toBe('manual');
 expect(z(area({surfaceMode:mode,surfaceId:'p'}))).toBe(8);
});
test('new Area starts auto and preserves null surfaceId',()=>expect(h.createDefaultLightingArea({width:20,depth:10})).toMatchObject({surfaceMode:'auto',surfaceId:null}));
for(const [id,height] of [[null,0],['p',8],['deleted',0]]) test(`manual surface ${id}`,()=>expect(z(area({surfaceMode:'manual',surfaceId:id}))).toBe(height));
test('auto normal stage and platform center',()=>{expect(z(area(),[])).toBe(0);expect(z(area())).toBe(8);});
for(const [x,y] of [[-1,4],[1,6],[0,4],[1,5]]) test(`inclusive boundary ${x},${y}`,()=>expect(z(area({x,y}))).toBe(8));
test('overlap uses highest platform and stable tie ordering',()=> {
 expect(z(area(),[pl,{...pl,id:'high',height:20}])).toBe(20);
 expect(h.resolvePlatformAtPoint(0,5,[pl,{...pl,id:'same'}]).id).toBe('p');
});
for(const patch of [{x:NaN},{y:Infinity},{x:'0'},{x:undefined}]) test(`invalid center ${JSON.stringify(patch)}`,()=>expect(z(area(patch))).toBe(0));
test('invalid platform heights safely return zero',()=>{for(const height of [NaN,Infinity,0,-1])expect(z(area(),[{...pl,height}])).toBe(0);});
test('frozen Area responds to platform add move resize height delete without saved ID changes',()=> {
 const a=Object.freeze(area()),before=JSON.stringify(a);
 expect(z(a,[])).toBe(0);expect(z(a)).toBe(8);expect(z(a,[{...pl,x:4}])).toBe(0);
 expect(z(a,[{...pl,x:4,width:10}])).toBe(8);expect(z(a,[{...pl,height:20}])).toBe(20);expect(z(a,[])).toBe(0);
 expect(JSON.stringify(a)).toBe(before);expect(a.surfaceId).toBe('saved');
});
for(const patch of [{width:40},{height:30},{rotation:135},{shape:'circle',radius:50}]) test(`center-only surface ignores ${JSON.stringify(patch)}`,()=> {
 expect(z(area(patch))).toBe(8);expect(z(area({...patch,x:2}))).toBe(0);
});
for(const kind of ['cue','boundary']) test(`${kind} Move uses current center and from mode`,()=> {
 const from=area({x:-4}),to=area({x:4,surfaceMode:'manual',positionMoveMode:'transition',positionMoveCounts:4});
 const resolve=t=>kind==='cue'?h.interpolateLightingAreaPositionState([from],[to],t,4,0):h.resolveBoundaryMoveArrivingAreas([to],[from],4,t,0);
 expect(z(resolve(0)[0])).toBe(0);const mid=resolve(2)[0];expect(mid.x).toBe(0);expect(mid.surfaceMode).toBe('auto');expect(z(mid)).toBe(8);expect(z(resolve(4)[0])).toBe(0);
});
test('Cue mode switches at destination, not during Fade',()=> {
 const from=area(),to=area({surfaceMode:'manual',surfaceId:null});
 for(const t of [0,1.99,2]) {
 const state=h.resolveLightingCueState({baseAreas:[from],baseBeams3D:[],cues:[{id:'c',count:2,fadeCounts:1,areas:[to],beams3D:[]}],elapsedCounts:t});
 expect(state.areas[0].surfaceMode).toBe(t<2?'auto':'manual');expect(z(state.areas[0])).toBe(t<2?8:0);
 }
});
test('Fade preserves both/from-only/to-only mode',()=> {
 const a=area(),b=area({surfaceMode:'manual',intensity:0});
 expect(h.interpolateLightingIntensityState([a],[],[b],[],0.5).areas[0]).toMatchObject({surfaceMode:'auto',intensity:0.5});
 expect(h.interpolateLightingIntensityState([a],[],[],[],0.5).areas[0].surfaceMode).toBe('auto');
 expect(h.interpolateLightingIntensityState([],[],[b],[],0.5).areas[0].surfaceMode).toBe('manual');
});
test('snapshot clipboard and Formation clone retain mode and saved ID',()=> {
 const a=area();const sc=h.cloneLightingSceneContentForSlide({areas:[a],beams3D:[],cues:[{id:'c',count:2,areas:[a],beams3D:[]}]},'new');
 for(const copy of [h.cloneLightingStateSnapshot([a],[]).areas[0],h.cloneLightingItemDataByType('area',a),h.remapLightingStateForCrossFormationPaste([a],[]).areas[0],sc.areas[0],sc.cues[0].areas[0]]) {
 expect(copy.surfaceMode).toBe('auto');expect(copy.surfaceId).toBe('saved');expect(copy).not.toBe(a);
 }
});
test('TopView polygon is independent of mode and surface',()=> {
 expect(h.getLightingAreaStagePoints(area())).toEqual(h.getLightingAreaStagePoints(area({surfaceMode:'manual',surfaceId:'p'})));
});
function callback(name,extras) {
 const match=source.match(new RegExp(`const ${name} = useCallback\\(\\s*([^]*?),\\s*\\[commitWork, activeLightingCueSelectionForEdit, isEditingNextFormationLightingBase\\]\\s*\\);`));
 return vm.runInNewContext(`(${match[1]})`,{isEditingNextFormationLightingBase:false,activeLightingCueSelectionForEdit:null,...extras});
}
test('actual surface commit preserves ID in auto and performs one commit per selection',()=> {
 let a=area({surfaceMode:'manual'}),count=0;
 const run=callback('setLightingAreaSurfaceCommit',{commitWork:fn=>{count++;a=fn(a);},resolveActiveLightingTargetSlideId:()=> 's',applyActiveLightingUpdate:(prev,s,c,t,id,patch)=>({...prev,...patch})});
 run('a','__auto__');expect(count).toBe(1);expect(a).toMatchObject({surfaceMode:'auto',surfaceId:'saved'});
 run('a','p');expect(count).toBe(2);expect(a).toMatchObject({surfaceMode:'manual',surfaceId:'p'});
 run('a','');expect(count).toBe(3);expect(a).toMatchObject({surfaceMode:'manual',surfaceId:null});
});
test('actual duplicate handler preserves mode and ID',()=> {
 let copy;const a=area();
 const run=callback('duplicateLightingArea',{makeId:p=>p+'new',commitWork:fn=>fn({}),resolveActiveLightingTargetSlideId:()=> 's',readActiveLightingLists:()=>({areas:[a],beams3D:[]}),writeActiveLightingLists:(prev,s,c,areas)=>{copy=areas[1];return prev;},setSelectedLightingAreaId:()=>{},setSelectedLightingItemKeys:()=>{}});
 run('a');expect(copy).toMatchObject({surfaceMode:'auto',surfaceId:'saved'});
});

// Exercise the actual Export models; unrelated music/performer paths are stubbed out.
const builderNames=['buildFormationExportModel','buildLightingCueExportModels'];
const builderCode=builderNames.map(n=>source.match(new RegExp(`function ${n}\\([^]*?\\n\\}(?=\\n|$)`))[0]).join('\n');
const builders=vm.runInNewContext(`${builderCode}\n({${builderNames.join(',')}})`,{
 ...h,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
 getKeepCounts:()=>4,getTransitionCounts:()=>4,resolveSlideMusicPosition:()=>null,formatExportMusicPositionLabel:()=>'',
 PERFORMER_DISPLAY_SCALES:['large'],PERFORMER_DISPLAY_SCALE_LARGE:'large',
 resolveLightingBeams3DForDisplay:()=>[],getTransitionLightingCues:(map,id)=>map[id]||[],
 getTransitionPosesForSlide:()=>null,interpolatePlacementsWithPaths:()=>({}),computeTransitionPaths:()=>[],
});
function exportArgs() {
 const slide={id:'s',placements:{}},next={id:'next',placements:{}};
 return {slide,slideIndex:0,slides:[slide,next],performers:[],stage:{width:20,depth:10},zones:{},musicSections:[],transitionCounts:{},
 showTrajectory:false,showLightingTrackingPaths:false,lightingEnabled:true,platforms:[pl],stageAppearance:{},
 lightingScenes:[{id:'scene',slideId:'s',enabled:true,areas:[area()],beams3D:[],cues:[{id:'keep',count:2,areas:[area({x:2})],beams3D:[]}]}],
 transitionLightingCues:{s:[{id:'move',count:2,areas:[area()],beams3D:[]}]}};
}
const rendererStart=source.indexOf('function renderAudienceFormationExport(');
const areaBlockStart=source.indexOf('  if (model.lightingAreas && model.lightingAreas.length > 0)',rendererStart);
const areaBlock=source.slice(areaBlockStart,source.indexOf('\n  }',areaBlockStart)+4);
function renderedPolygon(model) {
 const points=[],bounds={minX:-900,maxX:900,totalH:1000,bottomMargin:100,leftMargin:100};
 const ctx=new Proxy({}, {get:(_,key)=>(...args)=>{if(key==='moveTo'||key==='lineTo')points.push(args);}});
 vm.runInNewContext(areaBlock,{model,ctx,...h,lightingAreaColorHex:()=> '#fff',lightingAreaFillOpacity:()=>1,
 project3D:(x,y,z)=>h.projectAudiencePoint3D(bounds,10,x,y,z)});
 return {points,bounds};
}
test('Formation Export uses auto height and matches Audience shared projection',()=> {
 const model=builders.buildFormationExportModel(exportArgs());
 expect(model.lightingAreas[0].surfaceMode).toBe('auto');expect(z(model.lightingAreas[0],model.platforms)).toBe(8);
 const {points,bounds}=renderedPolygon(model);
 const expected=h.getLightingAreaStagePoints(model.lightingAreas[0]).map(p=>{
  const projected=h.projectAudiencePoint3D(bounds,10,p.x,p.y,8);return [projected.sx,projected.sy];
 });
 expect(points).toEqual(expected);
});
test('Lighting Cue Export start keep transition use each resolved center',()=> {
 const cuts=builders.buildLightingCueExportModels(exportArgs());
 expect(cuts).toHaveLength(3);
 expect(cuts.map(c=>z(c.lightingAreas[0],c.platforms))).toEqual([8,0,8]);
 for(const cut of cuts) expect(renderedPolygon(cut).points).toHaveLength(h.getLightingAreaStagePoints(cut.lightingAreas[0]).length);
});

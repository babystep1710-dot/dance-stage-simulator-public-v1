import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the application's pure helpers without changing its exports or loading React.
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const names = [
  'getPlatformStageRect', 'projectAudiencePoint', 'projectAudiencePoint3D', 'getPlatformAudienceFaces',
  'isPointInScreenPolygon', 'doesVerticalScreenSegmentIntersectPolygon',
  'doesPerformerBodyIntersectPlatformSilhouette', 'isWaitingAreaPlacementOccludedByPlatform', 'isBackstagePlacementOccludedByPlatform',
  'getPlacementSurfaceId', 'resolvePlacementSurfaceHeight', 'resolvePlatformAtPoint',
  'isPlacementUnderPlatform', 'isWingPlacementOccludedByPlatform', 'isPlacementOccludedByPlatform',
  'getLightingBeam3DTargetSurfaceMode', 'resolveLightingBeam3DTarget', 'getLightingBeam3DTargetSurfaceId', 'resolveLightingBeam3DTargetSurfaceHeight',
  'resolveLightingBeam3DEffectiveTarget', 'getLightingAreaSurfaceMode', 'getLightingAreaSurfaceId', 'resolveLightingAreaSurfaceHeight',
  'drawExportPerformerGhost', 'computeKneelingFigureGeometry', 'frontFigureChestMetrics', 'performerNumberFontSizeAudience',
];
const constants = ['UNIT_CM', 'PLATFORM_MIN_SIZE', 'PLATFORM_MAX_HEIGHT', 'PERSPECTIVE'];
constants.push('POSE_KNEELING', ...[...source.matchAll(/^const ((?:FIGURE_|KNEEL_)\w+) =/gm)].map((m) => m[1]));
const code = constants.map((name) => source.match(new RegExp(`const ${name} = [\\s\\S]*?;`))[0]).join('\n') + '\n' +
  names.map((name) => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
const h = vm.runInNewContext(`const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)); const lerp=(a,b,t)=>a+(b-a)*t; ${code}\n({${names.join(',')}, PLATFORM_MAX_HEIGHT})`);
const square = [{sx:0,sy:0},{sx:10,sy:0},{sx:10,sy:10},{sx:0,sy:10}];
const bounds = {minX:-900,maxX:900,totalH:1000,bottomMargin:100,leftMargin:100};
const platform = {id:'p',x:0,y:8,width:8,depth:2,height:20};
const placement = {x:0,y:12,area:'upstageBackstage'};
function geometry(pos=placement, transform) {
  const p = h.projectAudiencePoint3D(bounds,10,pos.x,pos.y,0);
  const top = {sx:p.sx,sy:p.sy-170*p.scale};
  const foot = transform ? transform(p) : p;
  const head = transform ? transform(top) : top;
  return {bounds,stageDepth:10,body:{x:foot.sx,footY:foot.sy,headY:head.sy},screenTransform:transform};
}
for (const [label, point, polygon, expected] of [
  ['inside',{sx:5,sy:5},square,true], ['outside',{sx:11,sy:5},square,false],
  ['boundary',{sx:0,sy:5},square,true], ['invalid point',{sx:NaN,sy:5},square,false],
  ['invalid polygon',{sx:5,sy:5},[null],false], ['missing polygon',{sx:5,sy:5},null,false],
]) test(`point-in-polygon ${label}`,()=>expect(h.isPointInScreenPolygon(point,polygon)).toBe(expected));
for (const [label,x,top,bottom,expected] of [
  ['endpoint inside',5,5,15,true], ['passes through',5,-5,15,true], ['outside',11,-5,15,false],
  ['vertical edge',0,-5,15,true], ['reversed endpoints',5,15,-5,true], ['invalid',NaN,0,10,false],
]) test(`vertical segment ${label}`,()=>expect(h.doesVerticalScreenSegmentIntersectPolygon(x,top,bottom,square)).toBe(expected));
test('depth gate rejects front placement even with overlap',()=> {
  expect(h.isBackstagePlacementOccludedByPlatform({...placement,y:6.99},[platform],geometry())).toBe(false);
});
test('behind depth gate with body overlap',()=>expect(h.isBackstagePlacementOccludedByPlatform(placement,[platform],geometry())).toBe(true));
test('behind depth gate without body overlap',()=> {
  const pos={...placement,x:20};
  expect(h.isBackstagePlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(false);
});
test('height changes silhouette overlap',()=> {
  expect(h.isBackstagePlacementOccludedByPlatform(placement,[{...platform,height:1}],geometry())).toBe(false);
  expect(h.isBackstagePlacementOccludedByPlatform(placement,[platform],geometry())).toBe(true);
});
for (const x of [-4.2,4.2]) test(`diagonal behind side ${x}`,()=> {
  const pos={...placement,x};
  expect(h.isBackstagePlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(true);
});
test('only one of several platforms overlaps',()=> {
  const other={...platform,x:30};
  expect(h.isBackstagePlacementOccludedByPlatform(placement,[other],geometry())).toBe(false);
  expect(h.isBackstagePlacementOccludedByPlatform(placement,[other,platform],geometry())).toBe(true);
});
test('Canvas fit and translation preserve Screen overlap',()=> {
  const transform=p=>({sx:230+p.sx*0.4,sy:80+p.sy*0.4});
  for(const x of [0,4.2,20]) {
    const pos={...placement,x};
    expect(h.isBackstagePlacementOccludedByPlatform(pos,[platform],geometry(pos,transform)))
      .toBe(h.isBackstagePlacementOccludedByPlatform(pos,[platform],geometry(pos)));
  }
});
test('stage area and missing screen geometry do not trigger backstage',()=> {
  expect(h.isBackstagePlacementOccludedByPlatform({...placement,area:'stage'},[platform],geometry())).toBe(false);
  expect(h.isBackstagePlacementOccludedByPlatform(placement,[platform])).toBe(false);
});
for (const area of ['stageLeft', 'stageRight', 'upstageBackstage']) {
  test(`${area}: shared silhouette overlap and front depth gate`,()=> {
    const pos={...placement,area};
    expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(true);
    expect(h.isWaitingAreaPlacementOccludedByPlatform({...pos,y:6.99},[platform],geometry(pos))).toBe(false);
    expect(h.isWaitingAreaPlacementOccludedByPlatform({...pos,y:7},[platform],geometry(pos))).toBe(true);
  });
}
for (const area of ['stageLeft', 'stageRight']) {
  test(`${area} to backstage changes no geometry result`,()=> {
    for (const x of [0,4.2,20]) {
      const pos={...placement,x,area};
      const g=geometry(pos);
      expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],g))
        .toBe(h.isWaitingAreaPlacementOccludedByPlatform({...pos,area:'upstageBackstage'},[platform],g));
      expect(h.isWingPlacementOccludedByPlatform(pos,[platform],g))
        .toBe(h.isBackstagePlacementOccludedByPlatform({...pos,area:'upstageBackstage'},[platform],g));
    }
  });
}
for (const sign of [-1,1]) {
  test(`old Wing margin and actual stage boundary crossed on side ${sign}`,()=> {
    const wide={...platform,width:40,depth:10,y:5};
    for (const [x,y,area] of [[22,9.5,sign<0?'stageLeft':'stageRight'],[22.1,9.5,sign<0?'stageLeft':'stageRight'],
      [22.1,10,sign<0?'stageLeft':'stageRight'],[22.1,10.001,'upstageBackstage']]) {
      const pos={x:x*sign,y,area};
      expect(h.isPlacementOccludedByPlatform(pos,[wide],geometry(pos))).toBe(true);
    }
  });
}
test('waiting helper rejects stage/null/missing geometry and zero-height platforms',()=> {
  for(const area of ['stage',null,undefined])
    expect(h.isWaitingAreaPlacementOccludedByPlatform({...placement,area},[platform],geometry())).toBe(false);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[platform])).toBe(false);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[{...platform,height:0}],geometry())).toBe(false);
});
test('Wing height and multiple platforms use the shared silhouette',()=> {
  const pos={...placement,area:'stageRight'};
  expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[{...platform,height:1}],geometry(pos))).toBe(false);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[{...platform,x:30},platform],geometry(pos))).toBe(true);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[{...platform,x:30}],geometry(pos))).toBe(false);
});
test('under-platform and elevated performer retain behavior',()=> {
  expect(h.isPlacementUnderPlatform({x:0,y:8,area:'stage'},[platform])).toBe(true);
  expect(h.isPlacementUnderPlatform({x:0,y:8,area:'stage',surfaceId:'p'},[platform])).toBe(false);
});
test('combined predicate preserves under OR waiting-area',()=> {
  for(const pos of [{x:0,y:8,area:'stage'},placement,{x:4.2,y:12,area:'stageRight'}])
    expect(h.isPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(true);
});
test('Beam Phase 3A fixed height and Phase 3B performer priority',()=> {
  const beam={target:{x:1,y:2,z:3},targetSurfaceId:'p'};
  expect(h.resolveLightingBeam3DEffectiveTarget(beam,{},[platform]).z).toBe(20);
  expect(h.resolveLightingBeam3DEffectiveTarget({...beam,targetSurfaceId:null},{},[platform]).z).toBe(3);
  expect(h.resolveLightingBeam3DEffectiveTarget({...beam,followPerformerId:'a'},{a:{x:2,y:3,area:'stage'}},[platform]).z).toBe(0);
  expect(h.resolveLightingBeam3DEffectiveTarget({...beam,followPerformerId:'a'},{a:{x:2,y:8,area:'stage',surfaceId:'p'}},[platform]).z).toBe(20);
  expect(beam.target.z).toBe(3);
});
test('Area Phase 3C surface and missing reference',()=> {
  expect(h.resolveLightingAreaSurfaceHeight({surfaceId:'p'},[platform])).toBe(20);
  expect(h.resolveLightingAreaSurfaceHeight({surfaceId:'missing'},[platform])).toBe(0);
});
test('platform max height remains 20',()=>expect(h.PLATFORM_MAX_HEIGHT).toBe(20));

for (const pose of ['standing', 'kneeling']) test(`ghost Export ${pose} retains dashed body and number rendering`,()=> {
  const calls=[];
  const ctx = new Proxy({}, {
    get: (_, name) => (...args) => calls.push([name,...args]),
    set: (_, name, value) => { calls.push([name,value]); return true; },
  });
  h.drawExportPerformerGhost(ctx,100,200,170,{color:'#123456',number:12},pose,170);
  expect(calls.filter(c=>c[0]==='save')).toHaveLength(2);
  expect(calls.filter(c=>c[0]==='restore')).toHaveLength(2);
  expect(calls).toContainEqual(['setLineDash',[4,3]]);
  expect(calls).toContainEqual(['globalAlpha',0.32]);
  expect(calls).toContainEqual(['globalAlpha',0.35]);
  expect(calls.filter(c=>c[0]==='stroke')).toHaveLength(3);
  expect(calls.some(c=>c[0]==='fillText' && c[1]==='12')).toBe(true);
  expect(calls.flat().filter(v=>typeof v==='number').every(Number.isFinite)).toBe(true);
});

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the application's pure helpers without changing its exports or loading React.
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// Test Cleanup Phase T2・PART A：resolveLightingBeam3DEffectiveTarget()のfollowPerformerId
// ケースが実際に辿るpure helper dependency chainを全文検索で確認し、必要な関数だけを
// 過不足なく追加した（不要なproductionコード全体をvmへ流し込む方式へは広げない＝PART C）。
// resolveLightingBeam3DEffectiveTarget
//   → resolvePlacementEffectiveSurfaceHeight（Lighting Phase L1でBeam follow Zの解決先が
//     旧resolvePlacementSurfaceHeight()からこちらへ変わった。stairs continuous Z対応）
//     → getPlacementSurfaceMode
//     → resolvePlacementSurfaceHeight（既存、追加不要）
//     → resolveStageConnectorHeightAtPointFromList
//       → resolveStageConnectorHeightAtPoint
//         → getStageConnectorStageRect
//         → isPointInsideStageConnectorRect
//         → resolveStageConnectorHeights
//           → resolveStageConnectorSurfaceHeight
//           → getStageConnectorFromSurfaceId / getStageConnectorToSurfaceId
//         → resolveStageConnectorProgressAtPoint
//           → getStageConnectorFacing
const names = [
  'getPlatformStageRect', 'projectAudiencePoint', 'projectAudiencePoint3D', 'getPlatformAudienceFaces',
  'isPointInScreenPolygon', 'doesVerticalScreenSegmentIntersectPolygon',
  'doesPerformerBodyIntersectPlatformSilhouette', 'isWaitingAreaPlacementOccludedByPlatform',
  'getPlacementSurfaceId', 'resolvePlacementSurfaceHeight', 'resolvePlatformAtPoint',
  'isPlacementUnderPlatform', 'isPlacementOccludedByPlatform',
  'getLightingBeam3DTargetSurfaceMode', 'resolveLightingBeam3DTarget', 'getLightingBeam3DTargetSurfaceId', 'resolveLightingBeam3DTargetSurfaceHeight',
  'resolveLightingBeam3DEffectiveTarget', 'getLightingAreaSurfaceMode', 'getLightingAreaSurfaceId', 'resolveLightingAreaSurfaceHeight',
  'drawExportPerformerGhost', 'computeKneelingFigureGeometry', 'frontFigureChestMetrics', 'performerNumberFontSizeAudience',
  // Test Cleanup Phase T2：Lighting Phase L1でresolveLightingBeam3DEffectiveTarget()が新たに
  // 依存するようになったstairs continuous Z解決チェーン一式。
  'getPlacementSurfaceMode', 'resolvePlacementEffectiveSurfaceHeight',
  'resolveStageConnectorHeightAtPointFromList', 'resolveStageConnectorHeightAtPoint',
  'getStageConnectorStageRect', 'isPointInsideStageConnectorRect',
  'resolveStageConnectorHeights', 'resolveStageConnectorProgressAtPoint',
  'resolveStageConnectorSurfaceHeight', 'getStageConnectorFromSurfaceId', 'getStageConnectorToSurfaceId',
  'getStageConnectorFacing',
];
const constants = ['UNIT_CM', 'PLATFORM_MIN_SIZE', 'PLATFORM_MAX_HEIGHT', 'PERSPECTIVE'];
constants.push('POSE_KNEELING', ...[...source.matchAll(/^const ((?:FIGURE_|KNEEL_)\w+) =/gm)].map((m) => m[1]));
// Test Cleanup Phase T2・PART B：上記dependency chainがconstに依存する箇所
// （getStageConnectorStageRect→STAGE_CONNECTOR_MIN_SIZE、isPointInsideStageConnectorRect→
// STAGE_CONNECTOR_POINT_EPSILON、resolveStageConnectorProgressAtPoint→
// STAGE_CONNECTOR_FACING_VECTORS、getStageConnectorFacing→STAGE_CONNECTOR_FACINGS）だけを
// 過不足なく追加。
constants.push('STAGE_CONNECTOR_MIN_SIZE', 'STAGE_CONNECTOR_POINT_EPSILON', 'STAGE_CONNECTOR_FACING_VECTORS', 'STAGE_CONNECTOR_FACINGS');
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
// Stage Connector Phase 1H.1で isBackstagePlacementOccludedByPlatform() / isWingPlacementOccludedByPlatform()
// は「isWaitingAreaPlacementOccludedByPlatform()から呼ばれない・他のどこからも呼ばれない未使用
// compatibility wrapper」としてreference audit済みで削除された（src/App.jsx内のコメント参照）。
// 以下は、その2関数を直接呼んでいた旧テストのうち、現行の統一helper
// isWaitingAreaPlacementOccludedByPlatform()（stageLeft/stageRight/upstageBackstageを1つの
// 実装で扱う）へ書き換えても意味が残るものだけを移植したもの。
// 「depth gate rejects front placement even with overlap」「behind depth gate with body overlap」
// 「stage area and missing screen geometry do not trigger backstage」は、下の
// 「shared silhouette overlap and front depth gate」ループ、および
// 「waiting helper rejects stage/null/missing geometry and zero-height platforms」テストと
// 完全に重複する内容だったため削除した（同じ入力・同じ期待値を別の書き方で二重にテストして
// いただけ）。
test('behind depth gate without body overlap',()=> {
  const pos={...placement,x:20};
  expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(false);
});
test('height changes silhouette overlap',()=> {
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[{...platform,height:1}],geometry())).toBe(false);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[platform],geometry())).toBe(true);
});
for (const x of [-4.2,4.2]) test(`diagonal behind side ${x}`,()=> {
  const pos={...placement,x};
  expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(true);
});
test('only one of several platforms overlaps',()=> {
  const other={...platform,x:30};
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[other],geometry())).toBe(false);
  expect(h.isWaitingAreaPlacementOccludedByPlatform(placement,[other,platform],geometry())).toBe(true);
});
test('Canvas fit and translation preserve Screen overlap',()=> {
  const transform=p=>({sx:230+p.sx*0.4,sy:80+p.sy*0.4});
  for(const x of [0,4.2,20]) {
    const pos={...placement,x};
    expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos,transform)))
      .toBe(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos)));
  }
});
for (const area of ['stageLeft', 'stageRight', 'upstageBackstage']) {
  test(`${area}: shared silhouette overlap and front depth gate`,()=> {
    const pos={...placement,area};
    expect(h.isWaitingAreaPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(true);
    expect(h.isWaitingAreaPlacementOccludedByPlatform({...pos,y:6.99},[platform],geometry(pos))).toBe(false);
    expect(h.isWaitingAreaPlacementOccludedByPlatform({...pos,y:7},[platform],geometry(pos))).toBe(true);
  });
}
// Stage Connector Phase 1H.1で isWingPlacementOccludedByPlatform() は削除された。この関数は
// 元々「stageLeft/stageRight用のisBackstagePlacementOccludedByPlatform()相当」の別実装として
// 存在し、下のテストは「wing版とbackstage版が同じ結果になること」を検証していた。しかし
// 現行実装ではstageLeft/stageRight/upstageBackstageはすべてisWaitingAreaPlacementOccludedByPlatform()
// という単一の実装を共有しており、そもそも別実装が存在しないため「両者が一致すること」を
// 検証する意味自体がなくなった（一致は実装上自明）。このテストはCASE 1（完全にobsolete）
// として削除した。
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
// Stage Connector Phase 1J.1.3で、isPlacementOccludedByPlatform()の定義から
// isPlacementUnderPlatform()とのOR条件が意図的に外された（src/App.jsx内のコメント参照）。
// 「platformの後ろに入った瞬間に高さに関わらず全身が消える」というbinary occlusionの
// root causeがこのOR条件だったため、これはバグ修正として行われた変更であり、古い仕様へ
// 戻すべきではない。以下は旧「combined predicate preserves under OR waiting-area」テスト
// （isPlacementOccludedByPlatform()がarea:'stage'のunder-platform placementに対してtrueを
// 返すことを期待していた）を、現行の正しい仕様（isPlacementOccludedByPlatform()は
// isWaitingAreaPlacementOccludedByPlatform()のみのalias。stage performerはこの経路では
// 一切hiddenにならない）に合わせて書き換えたもの。将来再びOR条件が誤って復活していないかを
// 検知するための回帰テストとして維持する。
test('isPlacementOccludedByPlatform is waiting-area only (does not also hide under-platform stage performers)',()=> {
  for (const pos of [{x:0,y:8,area:'stage'},{x:0,y:8,area:'stage',surfaceId:'p'},{x:4.2,y:12,area:null}])
    expect(h.isPlacementOccludedByPlatform(pos,[platform],geometry(pos))).toBe(false);
  for (const pos of [placement,{x:4.2,y:12,area:'stageRight'}])
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
// Test Cleanup Phase T2・PART F・G：Lighting Phase L1で追加されたstairs continuous Zが、
// Beam followPerformerIdのz解決（resolveLightingBeam3DEffectiveTarget→
// resolvePlacementEffectiveSurfaceHeight）へ正しく伝わることを確認する回帰テスト。
// 既存tests/lighting-beam-auto-surface.spec.jsはresolveStageConnectorHeightAtPointFromList()を
// 抽出はしているが、実際にstageConnectors配列を渡すテストケースは無く（全呼び出しが
// stageConnectors省略＝空配列扱い）、「stairs上のauto performerをBeamがfollowする」ケースは
// どのspecにもカバーされていなかったため追加する（低コストで再現できたためPART Fの
// 「無理なら追加しない」の対象外と判断）。
test('stairs continuous Z is used for Beam follow (auto performer)',()=> {
  // upstage向きのconnector。fromSurfaceId=null（通常舞台=0）→toSurfaceId='p'（platform.height=20）。
  // rect: x[-2,2] y[18,22]。(0,20)はrect中央＝進行度t=0.5 → 0 + (20-0)*0.5 = 10。
  const connector={x:0,y:20,width:4,depth:4,facing:'upstage',fromSurfaceId:null,toSurfaceId:'p'};
  const pos={x:0,y:20,area:'stage',surfaceMode:'auto'};
  const expectedZ=h.resolvePlacementEffectiveSurfaceHeight(pos,[platform],[connector]);
  expect(expectedZ).toBe(10);
  const beam={target:{x:1,y:2,z:3},targetSurfaceId:'p',followPerformerId:'a'};
  expect(h.resolveLightingBeam3DEffectiveTarget(beam,{a:pos},[platform],[connector]).z).toBe(expectedZ);
});
test('manual performer standing on stairs XY does not auto-climb for Beam follow',()=> {
  const connector={x:0,y:20,width:4,depth:4,facing:'upstage',fromSurfaceId:null,toSurfaceId:'p'};
  // surfaceMode省略＝manual（getPlacementSurfaceMode()の既存fallback）。stairsのrect内に物理的に
  // 立っていても、manual performerはBeam follow先としてはstairsのcontinuous Zへ上がらず、
  // 通常舞台の高さ（0）のまま扱われることを確認する。
  const pos={x:0,y:20,area:'stage'};
  const beam={target:{x:1,y:2,z:3},targetSurfaceId:'p',followPerformerId:'a'};
  expect(h.resolveLightingBeam3DEffectiveTarget(beam,{a:pos},[platform],[connector]).z).toBe(0);
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

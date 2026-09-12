import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const names = ['getNormalAudienceStairsDepthItems', 'audienceDepthMergeItemY', 'sortAudienceDepthMergedItems',
 'resolveOwnPlatformStructureDepthTieBreak', 'resolveLateralStairsPlatformTieBreak', 'sortAudienceStageStructureItems',
 'getPlacementSurfaceId', 'getStageConnectorStepDepthKeys'];
const code = names.map(n => source.match(new RegExp(`function ${n}\\([^]*?\\n\\}(?=\\n)`))[0]).join('\n');
const h = vm.runInNewContext(`${code}\n({${names.join(',')}})`, {
 AUDIENCE_DEPTH_MERGE_TIE_EPSILON: 1e-6, LATERAL_STAIRS_PLATFORM_TIE_EPSILON: 0.01,
 STAGE_CONNECTOR_FACING_VECTORS: { upstage: { fy: 1 }, downstage: { fy: -1 }, stageLeft: { fy: 0 }, stageRight: { fy: 0 } },
 getStageConnectorFacing: c => c.facing, getStageConnectorStageRect: () => ({ yMin: 2, yMax: 6 }),
 resolveStageConnectorHeights: () => ({ fromHeight: 0, toHeight: 4 }), deriveStageConnectorAudienceStepCount: () => 4,
 lerp: (a,b,t) => a+(b-a)*t,
});
const stairs = (key, depthKey, patch = {}) => ({ kind: 'stairs-tread', key, depthKey, displayMode: 'normal', connectedPlatformIds: ['p'], lateral: false, ...patch });
const part = (kind, depth, patch = {}) => ({ kind, key: kind, platformId: 'p', depthY: depth, occlusionDepthY: depth, ...patch });
const performer = (depth, patch = {}) => ({ kind: 'performer', key: 'person', depthY: depth, pos: { y: depth }, ...patch });
const sort = items => h.sortAudienceDepthMergedItems(items).map(i => i.key);
for (const facing of ['upstage','downstage','stageLeft','stageRight']) {
 test(`${facing}: existing step depth and internal order survive`, () => {
  const keys = h.getStageConnectorStepDepthKeys({ facing }, []);
  const items = keys.flatMap((y,i) => [stairs(`${i}-riser`,y,{kind:'stairs-riser'}),stairs(`${i}-tread`,y)]);
  expect(sort(h.getNormalAudienceStairsDepthItems(items))).toEqual(h.sortAudienceStageStructureItems(items).map(i=>i.key));
  expect(keys).toEqual(facing === 'upstage' ? [2.5,3.5,4.5,5.5] : facing === 'downstage' ? [5.5,4.5,3.5,2.5] : [4,4,4,4]);
 });
}
for (const kind of ['platform-front','platform-top-strip','platform-top-grid-line']) {
 for (const side of ['stageLeft','stageRight']) test(`${side}: connected ${kind} tie`, () => {
  const p=part(kind,4.005), s=stairs('stairs',4,{lateral:true});
  expect(sort([p,s])).toEqual(['stairs',kind]);
  expect(sort([s,p])).toEqual(['stairs',kind]);
 });
 test(`${kind}: two-platform safeguard`, () => {
  expect(sort([stairs('stairs',4,{lateral:true,hasTwoPlatformEndpoints:true,connectedPlatformIds:['p','q']}),part(kind,4.005)])).toEqual([kind,'stairs']);
 });
 test(`${kind}: no proximity inferred connection or distant tie`, () => {
  expect(sort([stairs('stairs',4,{lateral:true,connectedPlatformIds:['q']}),part(kind,4.005)])).toEqual([kind,'stairs']);
  expect(sort([stairs('stairs',4,{lateral:true}),part(kind,5)])).toEqual([kind,'stairs']);
 });
}
test('normal extraction excludes ghosts, retains geometry and leaves data unchanged', () => {
 const points=[{sx:1,sy:2}]; const input=[stairs('normal',4,{points}),stairs('ghost',5,{displayMode:'ghost'}),part('platform-front',3)];
 const before=JSON.stringify(input); const result=h.getNormalAudienceStairsDepthItems(input);
 expect(result.map(i=>i.key)).toEqual(['normal']); expect(result[0].points).toBe(points); expect(JSON.stringify(input)).toBe(before);
});
test('explicit generation order survives reordered input at equal depth', () => {
 const items=h.getNormalAudienceStairsDepthItems([stairs('riser',4,{kind:'stairs-riser'}),stairs('tread',4)]);
 expect(sort([...items].reverse())).toEqual(['riser','tread']);
});
for (const pose of ['standing','kneeling']) test(`${pose}: platform and stairs interleave with performer`, () => {
 const parts=[part('platform-top-strip',5),part('platform-front',2),stairs('stairs',3)];
 expect(sort([...parts,performer(6,{pose})])).toEqual(['person','platform-top-strip','stairs','platform-front']);
 expect(sort([...parts,performer(4,{pose})])).toEqual(['platform-top-strip','person','stairs','platform-front']);
 expect(sort([...parts,performer(1,{pose})])).toEqual(['platform-top-strip','stairs','platform-front','person']);
});
test('own platform exception stays ahead of normal physical depth', () => {
 expect(sort([performer(6,{pos:{surfaceId:'p'}}),part('platform-top-strip',5),part('platform-front',2)])).toEqual(['platform-top-strip','platform-front','person']);
});
test('Beam tie and mixed stairs / multiple platform depth', () => {
 expect(sort([performer(4),{kind:'beamSlice',key:'beam',depthY:4},stairs('stairs',5),part('platform-front',6,{key:'far',platformId:'far'}),part('platform-front',2,{key:'near'})])).toEqual(['far','stairs','beam','person','near']);
});
test('Screen and Export both use shared normal extraction and ghost-only legacy layer', () => {
 expect(source.match(/getNormalAudienceStairsDepthItems\(allItems\)/g)).toHaveLength(2);
 expect(source.match(/filter\(\(item\) => item.displayMode === "ghost"\)/g)).toHaveLength(2);
 expect(source.match(/if \(item.kind === "platform-front" \|\| item.kind === "stairs-riser" \|\| item.kind === "stairs-tread"\)/g)).toHaveLength(2);
});

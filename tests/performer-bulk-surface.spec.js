import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const names = ['getSelectedPlacementSurfaceValue','applySurfaceSettingToSelectedPlacements',
  'getPlacementSurfaceMode','getPlacementSurfaceId','resolvePlacementSurfaceHeight',
  'resolveAutoPlacementSurfaceId','resolvePlatformAtPoint','getPlatformStageRect',
  'resolveTransitionPlacementSurfaceId','applyAutoSurfaceAfterPlacementEdit'];
const functions = names.map(n=>source.match(new RegExp(`function ${n}\\([^]*?\\n\\}`))[0]).join('\n');
const h = vm.runInNewContext(`${source.match(/const PLATFORM_MIN_SIZE = [^;]+;/)[0]}\n${functions}\n({${names.join(',')}})`);
const platforms=[{id:'p1',x:0,y:2,width:2,depth:2,height:3},{id:'p2',x:5,y:2,width:2,depth:2,height:6}];
const ids=['a','b','c'];
function fixture() { return {
 a:{x:0,y:2,area:'stage',surfaceMode:'manual',surfaceId:null,pose:'kneeling'},
 b:{x:3,y:2,area:'stage',surfaceMode:'manual',surfaceId:'p1'},
 c:{x:5,y:2,area:'stage',surfaceMode:'manual',surfaceId:'p1'},
 outside:{x:0,y:2,area:'stage',surfaceMode:'manual',surfaceId:null},
}; }
function apply(placements,mode,platformId=null,selectedIds=ids) {
 return h.applySurfaceSettingToSelectedPlacements({placements,selectedIds,mode,platformId,platforms});
}
for(const [label,mode,platformId,value] of [['auto','auto',null,'__auto__'],['stage','manual',null,'__stage__'],['platform','manual','p1','p1']]) {
 test(`common ${label} select value`,()=>expect(h.getSelectedPlacementSurfaceValue(apply(fixture(),mode,platformId),ids,platforms)).toBe(value));
}
test('mixed mode and platform selection has empty value',()=> {
 const p=fixture();p.a.surfaceMode='auto';
 expect(h.getSelectedPlacementSurfaceValue(p,ids,platforms)).toBe('');
 expect(h.getSelectedPlacementSurfaceValue(fixture(),ids,platforms)).toBe('');
});
test('auto resolves A platform1 B stage C platform2 immediately',()=> {
 const p=fixture(),next=apply(p,'auto');
 expect(ids.map(id=>next[id].surfaceMode)).toEqual(['auto','auto','auto']);
 expect(ids.map(id=>next[id].surfaceId)).toEqual(['p1',null,'p2']);
 expect(ids.map(id=>h.resolvePlacementSurfaceHeight(next[id],platforms))).toEqual([3,0,6]);
 expect(h.getSelectedPlacementSurfaceValue(next,ids,platforms)).toBe('__auto__');
});
test('manual normal stage applies null to everyone',()=> {
 const next=apply(fixture(),'manual');
 for(const id of ids) expect(next[id]).toMatchObject({surfaceMode:'manual',surfaceId:null});
});
test('manual platform allows positions outside its rectangle',()=> {
 const next=apply(fixture(),'manual','p2');
 for(const id of ids) expect(next[id]).toMatchObject({surfaceMode:'manual',surfaceId:'p2'});
});
test('coordinates metadata selection and unselected performers remain unchanged',()=> {
 const p=fixture(),copy=structuredClone(p),selected=[...ids];
 Object.values(p).forEach(Object.freeze);Object.freeze(p);Object.freeze(selected);
 const next=apply(p,'auto',null,selected);
 for(const id of ids) expect({...next[id],surfaceMode:p[id].surfaceMode,surfaceId:p[id].surfaceId}).toEqual(p[id]);
 expect(next.outside).toBe(p.outside);
 expect(p).toEqual(copy);expect(selected).toEqual(ids);
});
test('deleted platform fallback is derived without modifying saved placements',()=> {
 const p=apply(fixture(),'manual','deleted'),copy=structuredClone(p);
 expect(h.getSelectedPlacementSurfaceValue(p,ids,platforms)).toBe('__stage__');
 expect(p).toEqual(copy);
 expect(ids.map(id=>h.resolvePlacementSurfaceHeight(p[id],platforms))).toEqual([0,0,0]);
});
test('legacy undefined mode is manual normal stage',()=> {
 const p={a:{x:1,y:2},b:{x:2,y:2}};
 expect(h.getSelectedPlacementSurfaceValue(p,['a','b'],platforms)).toBe('__stage__');
});
test('missing selection is safe and no valid placements returns original',()=> {
 const p=fixture();expect(apply(p,'auto',null,['missing'])).toBe(p);
 expect(h.getSelectedPlacementSurfaceValue(p,[],platforms)).toBe('');
 expect(h.getSelectedPlacementSurfaceValue(p,['a','missing'],platforms)).toBe('');
});
test('one placements result survives the existing edit reconciliation hook',()=> {
 const p=fixture();let calls=0;
 const updater=prev=>{calls++;return apply(prev,'auto');};
 const result=updater(p);
 expect(h.applyAutoSurfaceAfterPlacementEdit(p,result,platforms)).toBe(result);
 expect(calls).toBe(1);
 expect(ids.map(id=>result[id].surfaceId)).toEqual(['p1',null,'p2']);
});
test('actual bulk handler invokes existing commit once and preserves selection',()=> {
 const match=source.match(/const setSelectedPlacementSurfaceCommit = useCallback\(([^]*?), \[selectedIds, updateSlidePlacementsCommit, isTransitionActive\]\);/);
 let calls=0,result;
 const run=vm.runInNewContext(`(${match[1]})`,{
   isTransitionActive:false,selectedIds:ids,getPlatforms:w=>w.platforms,
   applySurfaceSettingToSelectedPlacements:h.applySurfaceSettingToSelectedPlacements,
   updateSlidePlacementsCommit:updater=>{calls++;result=updater(fixture(),{platforms});},
 });
 run('auto',null);expect(calls).toBe(1);expect(ids.map(id=>result[id].surfaceId)).toEqual(['p1',null,'p2']);
});
test('existing single handler retains auto/manual behavior',()=> {
 const match=source.match(/const setPlacementSurfaceCommit = useCallback\(\s*([^]*?),\s*\[updateSlidePlacementsCommit, isTransitionActive\]\s*\);/);
 let state=fixture(),calls=0;
 const run=vm.runInNewContext(`(${match[1]})`,{isTransitionActive:false,getPlatforms:w=>w.platforms,
 resolveAutoPlacementSurfaceId:h.resolveAutoPlacementSurfaceId,
 updateSlidePlacementsCommit:fn=>{calls++;state=fn(state,{platforms});}});
 run('a','auto',null);expect(state.a.surfaceId).toBe('p1');
 run('a','manual','p2');expect(state.a.surfaceId).toBe('p2');expect(calls).toBe(2);
});
test('Transition both auto follows current position, manual retains departure until arrival',()=> {
 const from={...fixture().a,surfaceMode:'auto',surfaceId:'p1'},to={...fixture().c,surfaceMode:'auto',surfaceId:'p2'};
 expect(h.resolveTransitionPlacementSurfaceId(from,to,{x:3,y:2,area:'stage'},0.5,platforms)).toBe(null);
 expect(h.resolveTransitionPlacementSurfaceId(from,to,{x:5,y:2,area:'stage'},0.9,platforms)).toBe('p2');
 expect(h.resolveTransitionPlacementSurfaceId({...from,surfaceMode:'manual'},to,{x:5,y:2,area:'stage'},0.9,platforms)).toBe('p1');
 expect(h.resolveTransitionPlacementSurfaceId({...from,surfaceMode:'manual'},to,{x:5,y:2,area:'stage'},1,platforms)).toBe('p2');
});

test('different deleted/manual surface settings still show mixed',()=> {
 const p=apply(fixture(),'manual','deleted');p.b={...p.b,surfaceId:null};
 expect(h.getSelectedPlacementSurfaceValue(p,ids,platforms)).toBe('');
});
for(const [label,selectedIds,isTransitionActive] of [['none',[],false],['single',['a'],false],['transition',ids,true]]) {
 test(`bulk handler prevents changes during ${label}`,()=> {
   const match=source.match(/const setSelectedPlacementSurfaceCommit = useCallback\(([^]*?), \[selectedIds, updateSlidePlacementsCommit, isTransitionActive\]\);/);
   let calls=0;
   const run=vm.runInNewContext(`(${match[1]})`,{selectedIds,isTransitionActive,updateSlidePlacementsCommit:()=>calls++});
   run('auto',null);expect(calls).toBe(0);
 });
}

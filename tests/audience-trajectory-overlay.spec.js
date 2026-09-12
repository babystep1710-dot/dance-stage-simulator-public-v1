import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const screen=source.slice(source.indexOf('function OverheadAudienceView'),source.indexOf('const IDLE_ANIMATION_STATE'));
const canvas=source.slice(source.indexOf('function renderAudienceFormationExport'),source.indexOf('function drawExportPerformerAudience'));
for(const kind of ['platform-front','platform-top-strip','stairs-tread','beamSlice']) test(`Screen trajectory follows ${kind} rendering`,()=>{
 const physical=screen.indexOf('{depthMergedItems.map(');const guide=screen.indexOf('{transitionPaths && transitionPaths.length > 0 && trajectorySource && (');
 expect(physical).toBeGreaterThan(-1);expect(guide).toBeGreaterThan(physical);expect(screen.indexOf(`item.kind === "${kind}"`,physical)).toBeLessThan(guide);
});
test('selected performers remain after trajectory; overlay is noninteractive',()=>{
 const guide=screen.indexOf('{transitionPaths && transitionPaths.length > 0 && trajectorySource && (');
 expect(screen.indexOf('{selectedSorted.map(',guide)).toBeGreaterThan(guide);
 expect(screen.slice(guide,screen.indexOf('{selectedSorted.map(',guide))).toContain('<g pointerEvents="none">');
});
test('Canvas trajectory follows physical scene and precedes waiting ghosts',()=>{
 const physical=canvas.indexOf('depthMergedItems.forEach(');const guide=canvas.indexOf('visibleTransitionPaths.forEach(');
 expect(physical).toBeGreaterThan(-1);expect(guide).toBeGreaterThan(physical);
 expect(canvas.indexOf('drawExportPerformerAudience(ctx',physical)).toBeLessThan(guide);
 expect(canvas.indexOf('drawExportPerformerGhost(ctx',guide)).toBeGreaterThan(guide);
});
test('Canvas overlay retains local state isolation and full-path sampling',()=>{
 const guide=canvas.indexOf('ctx.globalAlpha = EXPORT_TRAJECTORY_ALPHA;');
 expect(guide).toBeGreaterThan(canvas.indexOf('depthMergedItems.forEach('));
 const block=canvas.slice(guide,canvas.indexOf('// Stage Connector Phase 1H・PART B・F・G・N・O',guide));
 expect(block).toContain('buildAudienceTrajectoryScreenPoints(');
 expect(block).toContain('trajectoryArrowPoints(');
 expect(block).toContain('ctx.restore();');
 expect(block).not.toContain('model.trajectoryProgress,');
});

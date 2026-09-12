import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const modal = source.match(/function SlideListModal\([^]*?\n\}(?=\n)/)[0];
// Render the actual modal; isolate child UI and record the shared resolver's inputs.
async function renderModal(props, code = modal) {
  const calls = [];
  const compiled = await transformWithOxc(code, 'SlideListModal.jsx', { jsx: { runtime: 'classic' } });
  const Component = vm.runInNewContext(`${compiled.code}\nSlideListModal`, {
    React, useState, useCallback, useRef, useEffect, THEME: {},
    FormationThumbnail: () => null, SlideCardMenuButton: () => null,
    SlideListDropPlaceholderCard: () => null, ConfirmDeleteSlidesModal: () => null,
    getMusicAnchor: () => null, resolveSlideMusicPosition: () => null,
    formatFormationListMusicLabel: () => ({ text: '' }),
    findLightingSceneBySlideId: (scenes, id) => scenes.find(s => s.slideId === id),
    getLightingAreas: s => s.areas || [], getLightingBeams3D: s => s.beams3D || [],
    resolveLightingBeams3DForDisplay: (...args) => { calls.push(args); return args[0]; },
  });
  const html = renderToStaticMarkup(React.createElement(Component, {
    slides: [{ id: 's', name: '構成1', placements: { p: { x: 0, y: 2 } } }],
    performers: [], stage: {}, zones: {}, currentSlideIndex: 0, ...props,
  }));
  return { html, calls };
}
const platforms = [{ id: 'platform', height: 8 }];
const stageConnectors = [{ id: 'stairs', toSurfaceId: 'platform' }];
const scene = { slideId: 's', enabled: true, beams3D: [{ id: 'beam', targetSurfaceId: 'platform' }] };
for (const mode of ['normal', 'export-selection']) {
  test(`${mode}: forwards actual platforms and formation placements`, async () => {
    const { html, calls } = await renderModal({ mode, platforms, stageConnectors, lightingScenes: [scene] });
    expect(html).toContain('構成1');
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe(platforms);
    expect(calls[0][3]).toBe(stageConnectors);
    expect(calls[0][0]).toBe(scene.beams3D);
    expect(calls[0][1]).toEqual({ p: { x: 0, y: 2 } });
  });
  test(`${mode}: missing platforms safely defaults to empty`, async () => {
    expect((await renderModal({ mode, lightingScenes: [scene] })).calls[0][2]).toEqual([]);
  });
  test(`${mode}: disabled scene skips resolver`, async () => {
    expect((await renderModal({ mode, lightingScenes: [{ ...scene, enabled: false }] })).calls).toEqual([]);
  });
  test(`${mode}: no scene renders safely`, async () => {
    expect((await renderModal({ mode })).calls).toEqual([]);
  });
}
test('App passes its work-derived platforms to the shared modal', () => {
  expect(source).toContain('const platforms = getPlatforms(work);');
  expect(source.match(/<SlideListModal\b[^]*?\/>/)[0]).toContain('platforms={platforms}');
});
test('regression reproduces ReferenceError when the prop binding is removed', async () => {
  await expect(renderModal({ platforms, lightingScenes: [scene] }, modal.replace('  platforms = [],\n', '')))
    .rejects.toThrow('platforms is not defined');
});

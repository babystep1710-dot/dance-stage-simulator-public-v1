# Dance Stage Simulator - Development Rules

## Source of truth

- Main application is src/App.jsx.
- Unless explicitly requested, do not create replacement App_XXXX.jsx files.
- Edit the repository directly.
- Reuse existing architecture and helpers before introducing new abstractions.

## Workflow

Before implementation:

1. Inspect the related existing code.
2. Identify the smallest safe change.
3. Reuse existing helpers and data flow.
4. Avoid duplicating logic.

After implementation:

1. Run the build.
2. Run the relevant test suite.
3. Review the diff.
4. Report changed functions, test results, build results, and any remaining risks.

## Design principles

- Preserve backward compatibility.
- Prefer optional fields + safe fallback over migrations.
- Do not add new schema fields unless necessary.
- Avoid large refactors unless explicitly requested.
- Prefer incremental implementation followed by real-device testing.

## View responsibilities

- TopView is the editing / physical-placement view.
- Audience View is the audience-perspective visualization.
- Audience-specific occlusion, ghost, and height behavior must not leak into TopView unless explicitly required.
- Do not add duplicate Export-only logic when shared helpers can be reused.

## Platform rules

- work.platforms is independent from work.stage.
- 1 stage unit = 90cm.
- Reuse existing platform helpers.
- Do not change settled occlusion margins unless explicitly requested.
- Reuse performer surface helpers instead of duplicating surface-resolution logic.

## Lighting rules

- Lighting Area and Lighting Beam are separate concepts.
- Beam effective target calculation should remain centralized.
- Fade controls intensity.
- Beam Move and performer-follow remain separate responsibilities.
- Do not add physical ray/platform collision or clipping unless explicitly requested.
- Reuse Playback/Scrub placements rather than implementing separate lighting movement logic.

## Export

- Normal Formation Export and Lighting Cue Export should reuse the same model / rendering architecture whenever possible.
- Preserve TopView Export behavior unless the task explicitly targets it.
- Avoid unnecessary new Export Center controls.

## UI

- Reuse existing UI patterns.
- Avoid unnecessary cards, modals, switches, and settings.
- Keep the Export Center compact.
- Prefer clear behavior over exposing technical implementation details such as raw z values.

## Testing

- Add focused pure-function tests for new behavior where possible.
- Protect completed features from regression.
- Do not rewrite unrelated tests.
- Build and existing tests must pass before finishing a task.

## Current development style

- We decide product/design direction first, then implement.
- Prefer small phases such as Phase 3A / 3B rather than large all-at-once changes.
- After each meaningful phase, real-device behavior should be checked before proceeding.

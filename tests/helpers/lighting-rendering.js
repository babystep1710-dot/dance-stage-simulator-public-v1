// One Beam renders 24 depth slices (LIGHTING_BEAM_3D_DEPTH_SEGMENTS).
export const BEAM_DEPTH_SLICE_COUNT = 24;

// These fixtures contain one Beam and no Areas, platforms or performers.
// Slice polygons carry pointer-events directly; the footprint inherits it from
// its parent group. This excludes the footprint without adding production hooks.
export function audienceBeamSlices(page) {
  return page.locator('svg polygon[fill-opacity][pointer-events="none"]:not([stroke])');
}

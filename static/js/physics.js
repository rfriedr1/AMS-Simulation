/**
 * Physical constants and beam-optics helpers.
 *
 * Internal units used by the engine:
 *   length    mm (scene coordinates = real machine millimetres)
 *   energy    eV
 *   mass      kg
 *   curvature 1/mm
 */

export const AMU = 1.66053906660e-27; // kg
export const QE = 1.602176634e-19;    // C

/** Animation time scale: maps real ion velocity (m/s) to scene mm/s. */
export const ANIM_V = 4.3e-4;

/** Transverse offsets are drawn exaggerated by this factor (real machines
 *  are long and thin; without this the separation would be invisible). */
export const TRANSVERSE_EXAG = 3.0;

/** Non-relativistic momentum [kg·m/s] for mass in amu, kinetic energy in eV. */
export function momentum(massAmu, eKinEV) {
  return Math.sqrt(2 * massAmu * AMU * Math.max(eKinEV, 0) * QE);
}

/** Real ion speed in m/s. */
export function speed(massAmu, eKinEV) {
  return Math.sqrt(2 * Math.max(eKinEV, 0) * QE / (massAmu * AMU));
}

/** Curvature [1/mm] of an ion in a dipole field B [T]. */
export function magneticCurvature(massAmu, eKinEV, qAbs, B) {
  if (qAbs === 0 || eKinEV <= 1 || B <= 0) return 0;
  const p = momentum(massAmu, eKinEV);
  return (qAbs * QE * B / p) / 1000;
}

/** Curvature [1/mm] of an ion in a radial electric field [V/m]. */
export function electricCurvature(eKinEV, qAbs, fieldVm) {
  if (qAbs === 0 || eKinEV <= 1 || fieldVm <= 0) return 0;
  return (qAbs * fieldVm / (2 * eKinEV)) / 1000;
}

/** Rotate vector by -90° (screen coords, y down). */
export function rotM90(v) { return [v[1], -v[0]]; }

/** Rotate vector by +90° (screen coords, y down) → outward normal of bends. */
export function rotP90(v) { return [-v[1], v[0]]; }

/** Rotate vector by -theta (the turning sense of all MICADAS bends). */
export function rotMinus(v, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
}

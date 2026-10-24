"""MICADAS beamline model.

Geometry, apertures and nominal set-points of a MICADAS-type compact
radiocarbon AMS system (Synal et al., NIM B 259 (2007) 7-13; Ionplus AG):

  * caesium sputter ion source, C- extraction at ~40 kV
  * 90-degree low-energy (LE) injection magnet with "bouncer" (sequential
    injection of masses 12/13/14 by biasing the magnet vacuum chamber)
  * vacuum-insulated 200 kV tandem accelerator with helium stripper,
    charge state 1+ selected
  * 90-degree high-energy (HE) magnet (r = 350 mm) with off-axis Faraday
    cups for 12C+ and 13C+
  * 90-degree electrostatic analyzer, r = 380 mm, plate voltage +-40 kV
  * gas ionization detector for single-atom 14C counting

Every element is an object; the full machine is assembled in build_config()
by walking the reference beam path. All numbers handed to the frontend are
derived here, so the Python model is the single source of truth.
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional

from .species import species_config, REGISTRY, M_C14

# ---------------------------------------------------------------------------
# Physical constants
# ---------------------------------------------------------------------------
AMU = 1.66053906660e-27     # kg
QE = 1.602176634e-19        # C

# ---------------------------------------------------------------------------
# Design (nominal) operating point
# ---------------------------------------------------------------------------
V_SOURCE = 40e3             # V   ion source / injection potential
V_TERMINAL = 200e3          # V   tandem terminal voltage
REF_MASS = M_C14            # u   the LE/HE side is tuned to mass 14 (14C)
R_LE = 0.250                # m   LE magnet bending radius
R_HE = 0.350                # m   HE magnet bending radius
R_ESA = 0.380               # m   ESA bending radius
V_ESA_NOM = 40e3            # V   ESA plate voltage (each plate, +-)


def momentum_si(mass_amu: float, e_kin_ev: float) -> float:
    """Non-relativistic momentum in kg*m/s (beam energies are << mc^2)."""
    return math.sqrt(2.0 * mass_amu * AMU * e_kin_ev * QE)


def dipole_field(mass_amu: float, e_kin_ev: float, q: int, radius_m: float) -> float:
    """B [T] that bends the given ion on the given radius:  B = p / (q e r)."""
    return momentum_si(mass_amu, e_kin_ev) / (abs(q) * QE * radius_m)


# Energy after the tandem for the reference ion (charge 1+ after stripping):
# E = e*V_src + e*V_term (anion to terminal) + q*e*V_term (cation to ground)
E_INJ = V_SOURCE                            # eV
E_FINAL = V_SOURCE + 2.0 * V_TERMINAL       # eV

B_LE_NOM = dipole_field(REF_MASS, E_INJ, 1, R_LE)       # ~0.43 T
B_HE_NOM = dipole_field(REF_MASS, E_FINAL, 1, R_HE)     # ~1.02 T

# ESA: radial field E_r = 2*E_kin / (q*r). The plate gap is chosen such that
# the design point sits exactly at +-40 kV plate voltage (as in MICADAS).
ESA_FIELD_NOM = 2.0 * E_FINAL / R_ESA                   # V/m (q = 1)
ESA_GAP = 2.0 * V_ESA_NOM / ESA_FIELD_NOM               # m, ~34.5 mm

# Electrostatic steerers: kick angle = V * (L/gap) / (2*E_kin/q).
STEERER_GEOM = 4.0          # effective plate-length / plate-gap ratio


def _monitor_factor() -> float:
    """Calibration constant k of the molecular-background monitor.

    The 13CH-monitor cup collects the 13C+ break-up fragments, i.e. (almost)
    one fragment per injected 13CH. The detector background comes from the
    rare INTACT mass-14 molecular survivors (13CH+ and 12CH2+). Both rates
    are proportional to the injected hydride current, so

        N_background  =  k * N_monitor,
        k = sum_over_mass-14_hydrides( w_i * p_surv / (1 - p_surv) ) / w_13CH .

    In a real machine k is measured with 14C-free blanks; here we derive it
    from the model's survival probabilities (the spawn-weight ratio plays the
    role of the sample's typical hydride mix).
    """
    ch13 = next(s for s in REGISTRY if s.key == "CH13")
    total = 0.0
    for s in REGISTRY:
        if s.kind == "molecular" and abs(s.mass_amu - 14.0) < 0.5:
            p_surv = s.stripper.survival
            total += s.spawn_weight * p_surv / (1.0 - p_surv)
    return total / ch13.spawn_weight


# ---------------------------------------------------------------------------
# Beamline elements
# ---------------------------------------------------------------------------
def _rot_m90(v):
    """Rotate a 2D vector by -90 deg in screen coordinates (y down)."""
    return (v[1], -v[0])


@dataclass
class Element:
    """One section of the reference beam path.

    entry/direction are filled in by the Beamline walk. 'aperture' is the
    half-width (mm) of the vacuum chamber: particles further off-axis are
    lost on the wall.
    """
    key: str
    etype: str                  # drift|source|steerer|dipole|slit|accelerator|esa|cups|detector
    label: str
    blurb: str
    length: float = 0.0         # mm along the reference path (arc length for bends)
    aperture: float = 20.0      # mm half-width
    extra: dict = field(default_factory=dict)
    entry: tuple = (0.0, 0.0)
    direction: tuple = (0.0, 1.0)

    def to_dict(self):
        d = {
            "key": self.key,
            "type": self.etype,
            "label": self.label,
            "blurb": self.blurb,
            "length": round(self.length, 3),
            "aperture": self.aperture,
            "entry": [round(self.entry[0], 3), round(self.entry[1], 3)],
            "dir": [round(self.direction[0], 6), round(self.direction[1], 6)],
        }
        d.update(self.extra)
        return d


@dataclass
class Bend(Element):
    """A 90-degree sector element (magnet or ESA). All MICADAS bends turn the
    same way, which keeps the transverse coordinate continuous along the path."""
    radius: float = 250.0       # mm

    def __post_init__(self):
        self.length = self.radius * math.pi / 2.0
        self.extra = {**self.extra, "radius": self.radius, "angleDeg": 90}


class Beamline:
    """Walks the reference path and assigns entry points/directions."""

    def __init__(self, start=(0.0, 0.0), direction=(0.0, 1.0)):
        self.elements: List[Element] = []
        self._p = list(start)
        self._d = list(direction)

    def add(self, el: Element) -> Element:
        el.entry = tuple(self._p)
        el.direction = tuple(self._d)
        if isinstance(el, Bend):
            r = el.radius
            cx = self._p[0] + r * _rot_m90(self._d)[0]
            cy = self._p[1] + r * _rot_m90(self._d)[1]
            vx, vy = self._p[0] - cx, self._p[1] - cy
            rx, ry = _rot_m90((vx, vy))
            self._p = [cx + rx, cy + ry]
            self._d = list(_rot_m90(self._d))
        else:
            self._p[0] += self._d[0] * el.length
            self._p[1] += self._d[1] * el.length
        self.elements.append(el)
        return el

    def to_dict(self):
        out, s = [], 0.0
        for el in self.elements:
            d = el.to_dict()
            d["s0"] = round(s, 3)
            s += el.length
            out.append(d)
        return {"elements": out, "totalLength": round(s, 3)}


# ---------------------------------------------------------------------------
# The MICADAS machine
# ---------------------------------------------------------------------------
def build_beamline() -> Beamline:
    bl = Beamline(start=(0.0, 0.0), direction=(0.0, 1.0))

    bl.add(Element(
        key="source", etype="source", label="Cs sputter ion source",
        length=170, aperture=24,
        blurb="A caesium beam knocks carbon atoms out of the sample "
              "(graphite). On the way out they pick up an extra electron and "
              "become negative ions — the first trick of AMS: nitrogen-14, "
              "the worst lookalike of carbon-14, cannot form stable negative "
              "ions, so it is gone before the race even starts. The ions are "
              "pulled out by the source high voltage. CLICK the source to "
              "look inside it!",
        extra={"controls": ["srcKV"]},
    ))
    bl.add(Element(
        key="d_src", etype="drift", label="", length=120, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="st_le", etype="steerer", label="LE steerer",
        length=120, aperture=20,
        blurb="A pair of electrostatic plates that nudges the beam left or "
              "right to keep it centred — like trimming the rudder of a boat. "
              "Too much voltage and the beam misses everything downstream.",
        extra={"controls": ["stLE"], "geomFactor": STEERER_GEOM},
    ))
    bl.add(Element(
        key="d_le", etype="drift", label="", length=210, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Bend(
        key="mag_le", etype="dipole", label="LE magnet (mass filter)",
        radius=R_LE * 1000, aperture=18,
        blurb="The first sorting machine. In a magnetic field, light ions "
              "turn on a tighter curve than heavy ones, so only mass 14 makes "
              "it around the 90° corner: 14C — but also the impostor "
              "molecules 13CH and 12CH2, which weigh almost exactly the same. "
              "The 'bouncer' briefly changes the beam energy in the magnet so "
              "that 12C and 13C can take the same corner in short pulses.",
        extra={"controls": ["leB"], "fieldKey": "leB", "isLE": True,
               "nominalB": round(B_LE_NOM, 4)},
    ))
    bl.add(Element(
        key="d_inj1", etype="drift", label="", length=220, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="sl_inj", etype="slit", label="Injection slit",
        length=16, aperture=6,
        blurb="A narrow gate. Ions that came around the magnet on the wrong "
              "curve arrive off-centre and are stopped here.",
    ))
    bl.add(Element(
        key="d_inj2", etype="drift", label="", length=140, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="acc", etype="accelerator", label="200 kV tandem accelerator",
        length=650, aperture=22,
        blurb="The heart of MICADAS. The negative ions are pulled towards "
              "the +200 000 V terminal in the middle, gaining speed. There "
              "they fly through a thin cloud of helium gas — the 'stripper' — "
              "which rips electrons off: the ions flip from negative to "
              "positive (1+). Molecules cannot survive this and are torn "
              "apart. The now-positive ions are pushed away by the terminal "
              "and gain the same energy again: 40 keV + 2 × 200 keV = 440 keV.",
        extra={"controls": ["termKV"], "stripperAt": 0.5},
    ))
    bl.add(Element(
        key="d_he1", etype="drift", label="", length=170, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Bend(
        key="mag_he", etype="dipole", label="HE magnet (momentum filter)",
        radius=R_HE * 1000, aperture=48,
        blurb="The second sorting machine, now at 440 keV. It bends 14C(1+) "
              "exactly 90°. The stable beams 12C and 13C turn more sharply "
              "and land in two Faraday cups, where their beam current is "
              "measured. Molecular fragments have the wrong momentum and "
              "crash into the walls.",
        extra={"controls": ["heB"], "fieldKey": "heB", "isLE": False,
               "nominalB": round(B_HE_NOM, 4)},
    ))
    bl.add(Element(
        key="cups", etype="cups", label="Off-axis Faraday cups",
        length=240, aperture=60,
        blurb="Three metal cups parked where beams come out of the magnet. "
              "Two collect the stable 12C and 13C beams: their electric "
              "currents tell us how much carbon is in the sample. Between "
              "them sits the 13CH monitor cup: it catches the 13C fragments "
              "of broken-up 13CH molecules (they carry only 13/14 of the "
              "energy, so they fly on their own unique curve). That fragment "
              "current reveals how much hydride rode along with the mass-14 "
              "beam — and since a fixed, tiny fraction of those molecules "
              "survives the stripper, it predicts the molecular background "
              "in the 14C detector. 14C itself flies past, straight ahead.",
        extra={"cupPlane": 110, "cupHalfWidth": 4.5,
               "monitorFactor": round(_monitor_factor(), 6),
               "cups": [
                   {"key": "cup13", "species": "C13", "label": "¹³C cup"},
                   {"key": "cupCH", "species": "CH13", "label": "¹³CH monitor",
                    "monitor": True},
                   {"key": "cup12", "species": "C12", "label": "¹²C cup"},
               ]},
    ))
    bl.add(Element(
        key="st_he", etype="steerer", label="HE steerer",
        length=120, aperture=20,
        blurb="Fine alignment for the high-energy beam on its way to the "
              "energy filter.",
        extra={"controls": ["stHE"], "geomFactor": STEERER_GEOM},
    ))
    bl.add(Element(
        key="d_he2", etype="drift", label="", length=200, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="sl_he", etype="slit", label="HE slit", length=16, aperture=7,
        blurb="Another narrow gate that scrapes off ions on wrong "
              "trajectories before the final energy check.",
    ))
    bl.add(Element(
        key="d_esa1", etype="drift", label="", length=90, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Bend(
        key="esa", etype="esa", label="Electrostatic analyzer (energy filter)",
        radius=R_ESA * 1000, aperture=ESA_GAP * 1000 / 2.0,
        blurb="The final gatekeeper. Between two curved high-voltage plates, "
              "only ions with exactly the right energy follow the 90° curve — "
              "magnets check momentum, the ESA checks energy. Anything that "
              "scattered, changed charge or broke apart on the way carries "
              "the wrong energy and slams into a plate. What comes out is "
              "essentially pure 14C.",
        extra={"controls": ["esaKV"], "gapM": round(ESA_GAP, 6),
               "nominalKV": V_ESA_NOM / 1000.0},
    ))
    bl.add(Element(
        key="d_det", etype="drift", label="", length=260, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="sl_det", etype="slit", label="Detector slit", length=16, aperture=7,
        blurb="The last aperture in front of the detector.",
    ))
    bl.add(Element(
        key="d_det2", etype="drift", label="", length=80, aperture=20,
        blurb="Beam pipe — the ions coast through vacuum.",
    ))
    bl.add(Element(
        key="det", etype="detector", label="Gas ionization detector",
        length=150, aperture=16,
        blurb="The finish line. Each arriving ion tears through a small "
              "gas volume and leaves a trail of charge that is amplified and "
              "counted: one blip = one single atom of 14C. Comparing this "
              "count with the 12C current gives the 14C/12C ratio — and from "
              "it, via the 5730-year half-life, the age of the sample.",
    ))
    return bl


# ---------------------------------------------------------------------------
# User-facing controls (data-driven sliders)
# ---------------------------------------------------------------------------
def controls_config():
    return [
        {"key": "srcKV", "label": "Source voltage", "unit": "kV",
         "min": 20, "max": 60, "step": 0.1, "nominal": V_SOURCE / 1000,
         "group": "Ion source & injection",
         "hint": "Extraction energy of the negative ions (design: 40 kV)."},
        {"key": "stLE", "label": "LE steerer", "unit": "kV",
         "min": -0.5, "max": 0.5, "step": 0.005, "nominal": 0.0,
         "group": "Ion source & injection",
         "hint": "Sideways nudge for the slow 40 keV beam — a little goes a long way."},
        {"key": "leB", "label": "LE magnet field", "unit": "T",
         "min": 0, "max": 0.7, "step": 0.0005, "nominal": round(B_LE_NOM, 4),
         "group": "Ion source & injection",
         "hint": "Bends mass 14 by exactly 90° at the design energy."},
        {"key": "termKV", "label": "Terminal voltage", "unit": "kV",
         "min": 0, "max": 250, "step": 0.5, "nominal": V_TERMINAL / 1000,
         "group": "Accelerator",
         "hint": "Voltage of the tandem terminal (design: 200 kV)."},
        {"key": "heB", "label": "HE magnet field", "unit": "T",
         "min": 0, "max": 1.4, "step": 0.001, "nominal": round(B_HE_NOM, 4),
         "group": "High-energy analysis",
         "hint": "Bends 440 keV 14C(1+) by exactly 90°."},
        {"key": "stHE", "label": "HE steerer", "unit": "kV",
         "min": -2, "max": 2, "step": 0.01, "nominal": 0.0,
         "group": "High-energy analysis",
         "hint": "Sideways nudge for the 440 keV beam — note how much more "
                 "voltage the fast beam needs than at the LE steerer."},
        {"key": "esaKV", "label": "ESA voltage", "unit": "±kV",
         "min": 0, "max": 60, "step": 0.1, "nominal": V_ESA_NOM / 1000,
         "group": "High-energy analysis",
         "hint": "Plate voltage of the electrostatic analyzer (design: ±40 kV)."},
    ]


# ---------------------------------------------------------------------------
# Measurement calibration: maps stylised simulation rates onto realistic
# machine readings (the animation shows comparable beam intensities; the
# read-out panel converts them into what a real MICADAS would display).
# ---------------------------------------------------------------------------
HALF_LIFE_YR = 5730.0       # 14C half-life
MODERN_RATIO = 1.18e-12     # 14C/12C of a modern (F14C = 1) sample
CUP12_UA = 22.0             # typical 12C(1+) current in the HE cup [µA]
RATIO_13_12 = 0.0111        # natural 13C/12C
MONITOR_NA = 1.5            # stylised 13CH-fragment monitor current [nA]
# modern-sample detector rate implied by the 12C current and the ratio:
MODERN_CPS = CUP12_UA * 1e-6 / QE * MODERN_RATIO    # ~160 counts/s


def _samples():
    """Selectable samples in the ion source; F14C = 2^(-age/T_half)."""
    def f14c(age):
        return 2.0 ** (-age / HALF_LIFE_YR)
    return [
        {"key": "modern", "label": "Modern sample", "age_yr": 0, "f14c": 1.0},
        {"key": "y5000", "label": "5,000 years old", "age_yr": 5000,
         "f14c": round(f14c(5000), 5)},
        {"key": "y20000", "label": "20,000 years old", "age_yr": 20000,
         "f14c": round(f14c(20000), 5)},
        {"key": "y50000", "label": "50,000 years old", "age_yr": 50000,
         "f14c": round(f14c(50000), 6)},
        {"key": "blank", "label": "¹⁴C-free blank", "age_yr": None, "f14c": 0.0},
    ]


def _version():
    from .. import __version__
    return __version__


def build_config():
    bl = build_beamline()
    return {
        "machine": {
            "name": "MICADAS",
            "version": _version(),
            "fullName": "MIni CArbon DAting System",
            "designEnergy_keV": E_FINAL / 1000.0,
            "refMassAmu": REF_MASS,
        },
        "constants": {"amu": AMU, "qe": QE},
        "species": species_config(),
        "controls": controls_config(),
        "bouncer": {
            "refMassAmu": REF_MASS,
            "blurb": "Sequential injection: a fast voltage on the LE-magnet "
                     "chamber briefly changes the ion energy so that masses "
                     "12 and 13 follow the same 90° path as mass 14.",
        },
        "measurement": {
            "cup12_uA": CUP12_UA,
            "ratio13": RATIO_13_12,
            "monitor_nA": MONITOR_NA,
            "modernRatio": MODERN_RATIO,
            "modernCps": round(MODERN_CPS, 1),
            "halfLifeYr": HALF_LIFE_YR,
            "samples": _samples(),
        },
        "beamline": bl.to_dict(),
    }

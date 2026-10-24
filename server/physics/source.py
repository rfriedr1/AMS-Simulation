"""Model of the MICADAS hybrid caesium sputter negative-ion source.

Potentials and beam behaviour follow the CEZA MICADAS (Mannheim) as documented
in the CEZA explainer "The MICADAS caesium sputter ion source" (poster + web
page, with a ray-trace of the C- beam in the drawing's electrode geometry)
and the published descriptions (Synal 2007; Fahrni 2013; Ionplus manual):

  * three HV stages, all referenced to the ionizer:
      ionizer stage  -U_ion            = -30 kV   (ionizer, shroud, extractor)
      cathode stage  -(U_ion + U_cath) = -40 kV   (cathode, holder, immersion
                                                  lens plate ~1 mm in front)
      extractor      about 1 kV below the ionizer (~ -31 kV), a focus trim
      ground 0 V: vacuum box, ground electrode, box-lens outer electrodes
      box lens (einzel) centre about -15 kV
  * Cs oven ~120-130 degC feeds the ionizer assembly; hot W/Ta ionizer
    ~1000 degC (surface ionization, efficiency ~1); the spherical ionizer's
    centre of curvature lies on the sample, so Cs+ (10 keV) converges onto
    a ~1 mm spot through the aperture of the immersion lens plate
  * C- leaves the sample in all directions at a few eV, is turned forward
    at once by the field reaching through the lens aperture, crosses over
    just past the plate, opens slowly through the ionizer hole (~1 deg), is
    trimmed by the extractor, gains 30 keV in the extraction gap, leaves
    nearly parallel, is aimed by the x/y steerer (<= ~100 V) and focused by
    the box lens onto the object point of the 25 cm LE magnet -> 40 keV
  * secondary electrons co-extracted from the cathode are removed by small
    permanent "suppressor" magnets in the extraction lens
  * nitrogen forms no stable negative ion: 14N is removed at the source

The geometry in the frontend is a stylised 2D cutaway (scene units = mm);
the trajectories are zone physics shaped to reproduce the ray trace, not a
field solve.
"""

from .species import REGISTRY

# Design (nominal) operating point, CEZA values -----------------------------
CATHODE_KV = 10.0      # U_cath: cathode a further 10 kV below the ionizer
SOURCE_KV = 30.0       # U_ion: ionizer stage against ground
EXTRACTOR_OFFSET_KV = 1.0   # extractor below the ionizer potential (focus trim)
STEERER_V = 0.0        # x/y source steerer plates, up to ~100 V
BOX_LENS_KV = 15.0     # box lens (einzel) centre electrode, about -15 kV
INJECTION_KEV = CATHODE_KV + SOURCE_KV   # what the beamline expects (40 keV)


def _color(key, fallback):
    s = next((x for x in REGISTRY if x.key == key), None)
    return s.color if s else fallback


def controls_config():
    return [
        {"key": "srcKV", "label": "Source (ionizer) potential U_ion", "unit": "kV",
         "min": 10, "max": 40, "step": 0.5, "nominal": SOURCE_KV,
         "group": "Potentials (vs. ground)",
         "hint": "The ionizer stage against ground. Sets the 30 kV extraction "
                 "gap; together with U_cath it must add up to the 40 keV the "
                 "beamline is tuned for."},
        {"key": "cathodeKV", "label": "Cathode potential U_cath", "unit": "kV",
         "min": 2, "max": 15, "step": 0.1, "nominal": CATHODE_KV,
         "group": "Potentials (vs. ground)",
         "hint": "Cathode and lens plate float this much below the ionizer. "
                 "Cs⁺ impact energy and sputter yield; the C⁻ ions gain it "
                 "back on the way out."},
        {"key": "extrOffsetKV", "label": "Extractor (below U_ion)", "unit": "kV",
         "min": 0, "max": 3, "step": 0.1, "nominal": EXTRACTOR_OFFSET_KV,
         "group": "Beam formation",
         "hint": "Focus trim at the entrance of the extraction gap: sets how "
                 "convergent the beam enters the gap (about 1 kV makes it "
                 "leave nearly parallel). Tuned on blanks too."},
        {"key": "steererV", "label": "Source steerer x", "unit": "V",
         "min": -100, "max": 100, "step": 1, "nominal": STEERER_V,
         "group": "Beam formation",
         "hint": "Aims the 40 keV beam into the box lens (plates up to about "
                 "100 V). The deflection is drawn ~10× exaggerated so it stays "
                 "visible — in reality 100 V moves the beam by well under a mm."},
        {"key": "boxLensKV", "label": "Box lens (einzel) centre", "unit": "kV",
         "min": 0, "max": 30, "step": 0.5, "nominal": BOX_LENS_KV,
         "group": "Beam formation",
         "hint": "Centre electrode of the einzel lens. Focuses the nearly "
                 "parallel beam onto the object point of the LE magnet; the "
                 "beam leaves with the same energy it entered."},
    ]


def materials_config():
    """Target materials of the hybrid source and their stylised sputter
    cocktails (fractions of ejected particles). Real reference currents:
    50-150 uA C- from graphite, 10-20 uA from CO2 gas."""
    return [
        {
            "key": "graphite", "label": "Graphite (solid)",
            "blurb": "A pressed graphite pellet — the standard target after "
                     "sample combustion and graphitization.",
            "cCurrentUA": 60.0, "oCurrentUA": 4.0, "burst": 2.2,
            "mix": [
                {"kind": "C",  "label": "C⁻",  "p": 0.62, "color": _color("C12", "#fbbf24")},
                {"kind": "CH", "label": "CH⁻", "p": 0.08, "color": _color("CH13", "#a78bfa")},
                {"kind": "CH2", "label": "CH₂⁻", "p": 0.06, "color": _color("CH2_12", "#f472b6")},
                {"kind": "O",  "label": "O⁻",  "p": 0.06, "color": _color("O16", "#22d3ee")},
                {"kind": "neutral", "label": "neutral", "p": 0.18, "color": "#64748b"},
            ],
        },
        {
            "key": "gas", "label": "CO₂ gas (GIS)",
            "blurb": "CO₂/helium mixture pressed onto a titanium target — "
                     "direct gas measurement without graphitization. Lower "
                     "C⁻ yield, but plenty of O⁻.",
            "cCurrentUA": 13.0, "oCurrentUA": 28.0, "burst": 1.4,
            "mix": [
                {"kind": "C",  "label": "C⁻",  "p": 0.20, "color": _color("C12", "#fbbf24")},
                {"kind": "CH", "label": "CH⁻", "p": 0.05, "color": _color("CH13", "#a78bfa")},
                {"kind": "CH2", "label": "CH₂⁻", "p": 0.04, "color": _color("CH2_12", "#f472b6")},
                {"kind": "O",  "label": "O⁻",  "p": 0.42, "color": _color("O16", "#22d3ee")},
                {"kind": "neutral", "label": "neutral", "p": 0.29, "color": "#64748b"},
            ],
        },
    ]


def components_config():
    """Hover explanations for the cutaway drawing."""
    return {
        "oven": {
            "label": "Cs reservoir (oven)",
            "blurb": "A heated pot of metallic caesium (~120–130 °C). The "
                     "vapour flows through a heated line to a ring-shaped "
                     "nozzle in front of the ionizer. Oven temperature is the "
                     "main knob for the Cs flux — and so for the beam current "
                     "and for how fast the Cs charge is used up.",
        },
        "nozzle": {
            "label": "Cs ring nozzle",
            "blurb": "A ring-shaped spray nozzle just in front of the "
                     "ionizer, concentric with the beam axis (the cutaway "
                     "shows its two cross-sections). It sprays the heated Cs "
                     "vapour from the front evenly onto the hot cone, so "
                     "nearly all of the caesium lands on the ionizing surface "
                     "and returns as Cs⁺ — good caesium economy, and an "
                     "azimuthally uniform Cs⁺ beam on the sample.",
        },
        "ionizer": {
            "label": "Spherical ionizer · −U_ion (−30 kV)",
            "blurb": "A hot tungsten/tantalum cap (~1000 °C). Its work "
                     "function (4.5 eV) exceeds the Cs ionization energy "
                     "(3.89 eV), so a Cs atom leaving the surface leaves its "
                     "electron behind: ionization probability ≈ 1. The cap is "
                     "a sphere whose centre of curvature lies on the sample, "
                     "so the Cs⁺ ions fall through U_cath = 10 kV and converge "
                     "through the lens aperture onto a ~1 mm spot. The channel "
                     "behind its central hole is field-free.",
        },
        "cathode": {
            "label": "Sample cathode · −(U_ion+U_cath) (−40 kV)",
            "blurb": "The graphite sample on the cathode, 10 kV below the "
                     "ionizer. 10 keV Cs⁺ impacts eject carbon atoms and "
                     "clusters (sputtering). Condensed Cs lowers the surface's "
                     "work function from 4.7 to about 1.5–2 eV, close to the "
                     "1.26 eV with which carbon holds an extra electron — so "
                     "many sputtered atoms leave as C⁻. Nitrogen cannot hold "
                     "one: ¹⁴N is eliminated right here.",
        },
        "immersion": {
            "label": "Immersion lens plate (cathode potential)",
            "blurb": "A plate with an aperture, at cathode potential, about "
                     "1 mm in front of the sample. Behind it the field is "
                     "weak; at the aperture the 10 kV field of the Cs gap "
                     "rises steeply and its radial fringe pulls the few-eV "
                     "C⁻ ions towards the axis — an aperture between a "
                     "weak-field pocket and an accelerating field is a strong "
                     "converging lens. The beam crosses over just past the "
                     "plate and then opens only slowly (~1°) through the "
                     "ionizer hole. For the Cs⁺ beam the same aperture is only "
                     "weakly diverging. In the 2009 ETH source revision this "
                     "passive plate replaced two powered Cs lenses.",
        },
        "extractor": {
            "label": "Extractor · ≈ −U_ion − 1 kV",
            "blurb": "The aperture electrode facing the ionizer exit. It "
                     "belongs to the ionizer stage (fed from a small supply "
                     "referenced to it) and sits about 1 kV below −U_ion. It "
                     "sets where the 30 kV extraction field begins and how "
                     "far it reaches into the field-free channel — a weak "
                     "lens that trims the convergence of the beam entering "
                     "the gap. It is tuned with steerers and box lens for the "
                     "highest ¹³C current, and on blanks: the field shape "
                     "decides whether only the sputter spot or also its "
                     "Cs-coated rim (old carbon) is imaged into the beam. "
                     "Small permanent suppressor magnets here bend the "
                     "co-extracted electrons out of the beam.",
        },
        "ground": {
            "label": "Ground electrode · 0 V",
            "blurb": "The far side of the 30 kV extraction gap. Between the "
                     "extractor and this aperture the C⁻ ions gain the "
                     "remaining U_ion and leave with 40 keV — the injection "
                     "energy of the MICADAS. The two-aperture gap is slightly "
                     "diverging at its exit, which is why a steerer and a "
                     "box lens follow it.",
        },
        "steerer": {
            "label": "x/y source steerer · ≤ ~100 V",
            "blurb": "Two pairs of deflection plates near ground potential "
                     "that aim the 40 keV beam into the box lens — the "
                     "rudder of the source. Only one pair (x) is shown in "
                     "this cutaway. A few tens of volts suffice; the "
                     "deflection is drawn exaggerated here.",
        },
        "boxlens": {
            "label": "Box lens (einzel lens) · centre ≈ −15 kV",
            "blurb": "Three apertures: ground, about −15 kV, ground. The ions "
                     "slow down into the centre electrode and speed up again "
                     "— they leave with the same energy they entered, but the "
                     "curved fields bend the nearly parallel beam back "
                     "towards the axis and focus it onto the object point of "
                     "the 25 cm low-energy magnet. The MICADAS name for its "
                     "einzel lens is 'box lens'.",
        },
        "exit": {
            "label": "Object point of the LE magnet",
            "blurb": "Where the source hands over: the box lens focuses the "
                     "beam here, and the low-energy magnet images this point "
                     "onto its exit slit. Everything that arrives — 40 keV "
                     "C⁻, CH⁻, CH₂⁻, O⁻ … — is sorted by mass in the "
                     "beamline from here on.",
        },
    }


def build_source_config():
    return {
        "nominal": {
            "cathodeKV": CATHODE_KV, "srcKV": SOURCE_KV,
            "extrOffsetKV": EXTRACTOR_OFFSET_KV, "steererV": STEERER_V,
            "boxLensKV": BOX_LENS_KV,
            "injectionKeV": INJECTION_KEV,
        },
        "display": {
            # stylised sim rate -> realistic current mapping (see beamline
            # measurement calibration for the same pattern)
            "csCurrentUA": 150.0,       # typical Cs+ beam on target
        },
        "controls": controls_config(),
        "materials": materials_config(),
        "components": components_config(),
    }

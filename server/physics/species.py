"""Ion species transported through the MICADAS beamline.

Every species that can be injected from the caesium sputter source is an
IonSpecies. Mass-14 molecular ions (13CH-, 12CH2-) are the classic
interferences in radiocarbon AMS: they pass the low-energy magnet together
with 14C- and are only removed in the helium stripper of the accelerator,
where collisions tear them apart. Their charged fragments are described by
FragmentSpec and are filtered out by the high-energy magnet and the ESA.

New species (e.g. 12CH-, 13CH2-, or other elements for future beamlines)
can be added to the REGISTRY without touching any other code: backend and
frontend are fully data-driven.
"""

from dataclasses import dataclass, field, asdict
from typing import List, Optional

# Atomic masses in u (CODATA / AME2020, electron binding ignored)
M_H = 1.007825
M_C12 = 12.000000
M_C13 = 13.003355
M_C14 = 14.003242
M_O16 = 15.994915


@dataclass(frozen=True)
class FragmentSpec:
    """A charged fragment produced when a molecule breaks up in the stripper.

    The fragment keeps the parent's velocity, i.e. it carries the fraction
    mass/parent_mass of the parent's kinetic energy at the moment of breakup.
    """
    label: str
    html: str
    mass_amu: float
    count: int = 1
    color: str = "#94a3b8"

    def to_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class StripperBehaviour:
    """What happens to a species in the helium gas stripper at the terminal."""
    kind: str                 # 'atomic' | 'molecular'
    charged_fraction: float   # probability to end up as a 1+ ion
    survival: float = 0.0     # molecules only: probability to survive intact (1+)

    def to_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class IonSpecies:
    key: str
    label: str                # plain text, e.g. "13CH"
    html: str                 # pretty label, e.g. "¹³CH⁻"
    mass_amu: float
    charge: int               # charge state out of the ion source (in units of e)
    color: str
    kind: str                 # 'atomic' | 'molecular'
    spawn_weight: float       # relative visual spawn rate (NOT natural abundance)
    stripper: StripperBehaviour
    fragments: List[FragmentSpec] = field(default_factory=list)
    note: str = ""
    # Whether the bouncer (sequential injection) has a voltage slot for this
    # mass. Only masses 12/13/14 are cycled; anything else gets no help at
    # the LE magnet and is dumped there.
    bounced: bool = True

    def to_dict(self):
        d = asdict(self)
        d["stripper"] = self.stripper.to_dict()
        d["fragments"] = [f.to_dict() for f in self.fragments]
        return d


# He-stripping at 200 kV favours the 1+ charge state (up to ~47 % transmission
# for 12C in the real machine). The fractions below are stylised for a clear
# visual story; losses show up as neutralised ions flying straight on.
_ATOMIC = StripperBehaviour(kind="atomic", charged_fraction=0.85)
# Real molecular survival after enough He collisions is ~1e-6; we use a far
# larger value so that the audience occasionally sees an "impostor" sneak
# through and understands why the stripper matters.
_MOLECULAR = StripperBehaviour(kind="molecular", charged_fraction=0.0, survival=0.004)


REGISTRY: List[IonSpecies] = [
    IonSpecies(
        key="C12", label="12C", html="¹²C⁻",
        mass_amu=M_C12, charge=-1, color="#fbbf24", kind="atomic",
        spawn_weight=1.0, stripper=_ATOMIC,
        note="Stable carbon — 98.9 % of all carbon. Measured as an electric "
             "current in an off-axis Faraday cup after the HE magnet.",
    ),
    IonSpecies(
        key="C13", label="13C", html="¹³C⁻",
        mass_amu=M_C13, charge=-1, color="#34d399", kind="atomic",
        spawn_weight=0.85, stripper=_ATOMIC,
        note="Stable carbon — 1.1 % of all carbon. Measured in its own "
             "Faraday cup; the 13C/12C ratio corrects for fractionation.",
    ),
    IonSpecies(
        key="C14", label="14C", html="¹⁴C⁻",
        mass_amu=M_C14, charge=-1, color="#f43f5e", kind="atomic",
        spawn_weight=0.7, stripper=_ATOMIC,
        note="Radiocarbon — only ~1 in 10¹² carbon atoms in a modern "
             "sample. The star of the show: counted one atom at a time in the "
             "gas ionization detector.",
    ),
    IonSpecies(
        key="CH13", label="13CH", html="¹³CH⁻",
        mass_amu=M_C13 + M_H, charge=-1, color="#a78bfa", kind="molecular",
        spawn_weight=0.5, stripper=_MOLECULAR,
        fragments=[
            FragmentSpec(label="13C fragment", html="¹³C⁺",
                         mass_amu=M_C13, count=1, color="#c4b5fd"),
            FragmentSpec(label="proton", html="H⁺",
                         mass_amu=M_H, count=1, color="#7dd3fc"),
        ],
        note="Molecular impostor: mass 14.011 u is far too close to 14C "
             "(14.003 u) for the magnets to tell apart. It is destroyed in the "
             "helium stripper.",
    ),
    IonSpecies(
        key="CH12", label="12CH", html="¹²CH⁻",
        mass_amu=M_C12 + M_H, charge=-1, color="#60a5fa", kind="molecular",
        spawn_weight=0.5, stripper=_MOLECULAR,
        fragments=[
            FragmentSpec(label="12C fragment", html="¹²C⁺",
                         mass_amu=M_C12, count=1, color="#93c5fd"),
            FragmentSpec(label="proton", html="H⁺",
                         mass_amu=M_H, count=1, color="#7dd3fc"),
        ],
        note="Molecular impostor at mass 13.008 u — it rides along in the "
             "bouncer's mass-13 time slot with ¹³C and threatens the stable-"
             "isotope measurement: its ¹²C fragment lands just outside the "
             "¹²C cup, and a rare intact survivor has almost exactly the "
             "rigidity of real ¹³C and ends up in the ¹³C cup.",
    ),
    IonSpecies(
        key="CH2_12", label="12CH2", html="¹²CH₂⁻",
        mass_amu=M_C12 + 2 * M_H, charge=-1, color="#f472b6", kind="molecular",
        spawn_weight=0.5, stripper=_MOLECULAR,
        fragments=[
            FragmentSpec(label="12C fragment", html="¹²C⁺",
                         mass_amu=M_C12, count=1, color="#f9a8d4"),
            FragmentSpec(label="proton", html="H⁺",
                         mass_amu=M_H, count=2, color="#7dd3fc"),
        ],
        note="Molecular impostor at mass 14.016 u. Smashed into 12C and two "
             "protons in the stripper; the fragments have the wrong momentum "
             "and energy and are swept aside downstream.",
    ),
    IonSpecies(
        key="O16", label="16O", html="¹⁶O⁻",
        mass_amu=M_O16, charge=-1, color="#22d3ee", kind="atomic",
        spawn_weight=1.2, stripper=_ATOMIC, bounced=False,
        note="When CO2 gas is measured directly (instead of graphite), the "
             "sputter source produces more O- than C- — oxygen forms very "
             "stable negative ions. At mass 16 it is far too heavy for the "
             "mass-14 setting: it bends too little in the LE magnet and is "
             "dumped on its outer wall before ever reaching the accelerator. "
             "The bouncer has no time slot for mass 16, so it gets no help.",
    ),
]


def species_config():
    return [s.to_dict() for s in REGISTRY]

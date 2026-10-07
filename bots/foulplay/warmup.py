#!/usr/bin/env python3
"""Pre-warm foul play's on-disk dataset caches at image build time.

Downloads the Smogon chaos stats and foul-play team datasets for gen9ou so
the container never needs network access at runtime (the arena runs it with
--network none).

Note: the Smogon cache file is keyed by format, not month, so the snapshot
baked here is what every match uses — deterministic opponent modeling.
Rebuild the image to refresh it.
"""
import logging

from fp.battle.helpers import normalize_name
from fp.config import FoulPlayConfig
from fp.data import pokedex
from fp.data.sets import SmogonSets, TeamDatasets
from fp.format_spec import FormatSpec

FORMAT = "gen9ou"


def main():
    logging.basicConfig(level=logging.INFO)
    FoulPlayConfig.pokemon_format = FORMAT
    spec = FormatSpec.from_format_string(FORMAT)

    # Every Pokemon in the dex: the bulk files are per-format, so one
    # download covers the whole population; filtering is local.
    names = {normalize_name(n) for n in pokedex.keys()}

    smogon = SmogonSets()
    smogon.initialize(spec, names)
    print("smogon sets cached for {} pokemon".format(len(smogon.pkmn_sets)))

    teams = TeamDatasets()
    teams.initialize(spec, names)
    print("team datasets cached for {} pokemon".format(len(teams.pkmn_sets)))


if __name__ == "__main__":
    main()

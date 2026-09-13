// Neon Deck themes.
//
// Six themes, deliberately different along axes a product owner would actually
// argue about: how loud the art is, how "premium" it reads, how much it cost to
// make. Chapter 08's first question -- "which theme do we build next?" -- is only
// interesting because these differ in more than palette.
//
// `art_cost_usd` and `released_on` are NOT in this file's copy of the truth for the
// analytics stack. They live in infra/seed/themes.csv, which is a third system the
// fabric has to federate against in chapter 02. Duplicating them here would defeat
// the exercise; the game only needs what it has to draw.

export const THEMES = {
  neon_nights: {
    id: "neon_nights",
    name: "Neon Nights",
    felt: "#1a0a2e",
    feltEdge: "#2d1b4e",
    accent: "#ff2d95",
    accent2: "#00f0ff",
    text: "#f4e9ff",
    chipRim: "#00f0ff",
    intensity: "high",       // animation + audio loudness
    register: "playful",
  },
  gilded_vault: {
    id: "gilded_vault",
    name: "Gilded Vault",
    felt: "#111008",
    feltEdge: "#241f10",
    accent: "#e8c15a",
    accent2: "#8c6b1f",
    text: "#f6efdc",
    chipRim: "#e8c15a",
    intensity: "low",
    register: "premium",
  },
  deep_reef: {
    id: "deep_reef",
    name: "Deep Reef",
    felt: "#062a34",
    feltEdge: "#0a3f4d",
    accent: "#3fe0c8",
    accent2: "#1c7f96",
    text: "#e2f7f5",
    chipRim: "#3fe0c8",
    intensity: "low",
    register: "calm",
  },
  high_desert: {
    id: "high_desert",
    name: "High Desert",
    felt: "#2e1508",
    feltEdge: "#4a2410",
    accent: "#f08a3c",
    accent2: "#b3471d",
    text: "#fbeadb",
    chipRim: "#f08a3c",
    intensity: "medium",
    register: "warm",
  },
  midnight_express: {
    id: "midnight_express",
    name: "Midnight Express",
    felt: "#0b1220",
    feltEdge: "#152238",
    accent: "#7aa2f7",
    accent2: "#bb9af7",
    text: "#e6ecff",
    chipRim: "#7aa2f7",
    intensity: "medium",
    register: "premium",
  },
  lucky_bamboo: {
    id: "lucky_bamboo",
    name: "Lucky Bamboo",
    felt: "#0d2415",
    feltEdge: "#164026",
    accent: "#e03131",
    accent2: "#4cc38a",
    text: "#eafbef",
    chipRim: "#4cc38a",
    intensity: "high",
    register: "playful",
  },
};

export const THEME_IDS = Object.keys(THEMES);
export const DEFAULT_THEME = "neon_nights";

// Slot reel symbols vary per theme so a spin's payload is theme-specific. This is
// a small thing that matters later: chapter 02 discovers that `symbols` cannot be
// compared across themes without the theme, and chapter 05 gives it a class.
export const REEL_SYMBOLS = {
  neon_nights:      ["◆", "★", "♥", "7", "☆", "◇"],
  gilded_vault:     ["⧫", "♛", "⚜", "7", "◈", "⬖"],
  deep_reef:        ["🐚", "🌊", "🐠", "7", "🪸", "⚓"],
  high_desert:      ["🌵", "☀", "🦂", "7", "🪨", "🌾"],
  midnight_express: ["🚂", "⌛", "🎩", "7", "🗝", "✦"],
  lucky_bamboo:     ["🎋", "🧧", "🐉", "7", "🪙", "🍀"],
};

export function theme(id) {
  return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

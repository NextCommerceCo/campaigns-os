// Element parity comparator (Appendix A of the stream P contract). This is the
// P2 stub: it exports the contract's names so the rules module has a file to
// import, and compareElementParity throws, so every compared cell reads
// unexercised / comparator_failed until the P3 comparator replaces this file.
export const PARITY_COMPARATOR_VERSION = "parity-compare/v1";
export const PARITY_TOLERANCES = Object.freeze({
  position_px: 6, size_px: 6, gap_px: 6,
  font_size_px: 0.6, line_height_px: 2, letter_spacing_px: 0.2,
  color_channel: 3, fuzzy_jaccard: 0.6, missing_copy_min_chars: 4,
});
export const PARITY_PROBE_LIMITS = Object.freeze({
  elements: 1500, text_chars: 500, page_text_chars: 262144, font_faces: 200, selector_path_chars: 2048,
});

export function isProbeOutput() {
  throw new Error("The element parity comparator is not implemented in this version.");
}

export function compareElementParity() {
  throw new Error("The element parity comparator is not implemented in this version.");
}

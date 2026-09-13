// The order-bump marker vocabulary, read as a module rather than as source
// text. These assertions are about the shape of the exported contract — one
// list of marker families, a container list derived from it, and the accepted
// fill written the way a browser serialises a colour — so they need no browser
// and run in the ordinary `node --test` pass. The rendering behaviour they
// support is proved against a real layout engine in
// qa-order-bump.browser.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ORDER_BUMP_ACCEPTED_FILL_COLOR,
  ORDER_BUMP_MARKER_CONTAINERS,
  ORDER_BUMP_MARKER_EXCLUDED,
  ORDER_BUMP_MARKER_FAMILIES,
  ORDER_BUMP_PROBE_INPUT,
} from "./qa-order-bump.mjs";

// The vocabulary as it stood when the families and the containers were two
// hand-maintained literals. Pinned here so collapsing them to one source of
// truth cannot quietly change which selectors count as a marker.
const FAMILIES_BEFORE = [
  ".bump-check",
  "[data-next-toggle-check]",
  "[os-component='check']",
  ".checkbox__icon",
];

test("the marker families are unchanged by deriving the container list from them", () => {
  assert.deepEqual([...ORDER_BUMP_MARKER_FAMILIES], FAMILIES_BEFORE);
  // Family order decides which marker wins when a toggle has more than one, so
  // it is part of the contract, not an accident of how the list was typed.
  assert.equal(ORDER_BUMP_MARKER_FAMILIES[0], ".bump-check", "the most specific family is tried first");
});

test("the container list is the family list, not a second copy of it", () => {
  assert.equal(ORDER_BUMP_MARKER_CONTAINERS, ORDER_BUMP_MARKER_FAMILIES, "one list, so the two cannot drift");
  // The previous container literal held these same four selectors in a
  // different order. Order is immaterial to what a container list does — it is
  // joined into a single `closest()` query, resolved by tree position — so the
  // membership is what has to be preserved, and it is.
  assert.deepEqual([...ORDER_BUMP_MARKER_CONTAINERS].sort(), [...FAMILIES_BEFORE].sort());
});

test("the probe input carries the whole vocabulary the evaluate body reads", () => {
  assert.deepEqual(Object.keys(ORDER_BUMP_PROBE_INPUT).sort(), [
    "acceptedFillColor",
    "markerContainers",
    "markerExcluded",
    "markerFamilies",
    "toggleSelector",
  ]);
  assert.equal(ORDER_BUMP_PROBE_INPUT.acceptedFillColor, ORDER_BUMP_ACCEPTED_FILL_COLOR);
  assert.equal(ORDER_BUMP_PROBE_INPUT.markerFamilies, ORDER_BUMP_MARKER_FAMILIES);
  assert.equal(ORDER_BUMP_PROBE_INPUT.markerContainers, ORDER_BUMP_MARKER_CONTAINERS);
  assert.equal(ORDER_BUMP_PROBE_INPUT.markerExcluded, ORDER_BUMP_MARKER_EXCLUDED);
});

test("the accepted fill is written the way getComputedStyle serialises a colour", () => {
  // The `fill` family compares this string against a computed
  // `background-color`, and a browser reports an opaque colour as
  // `rgb(r, g, b)` with that exact spacing. A hex or `rgba()` spelling would
  // compare unequal against every page and silently retire the family.
  assert.match(ORDER_BUMP_ACCEPTED_FILL_COLOR, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
  assert.equal(ORDER_BUMP_ACCEPTED_FILL_COLOR, "rgb(45, 148, 127)");
});

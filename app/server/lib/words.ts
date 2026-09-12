import crypto from "node:crypto";

// Short, unambiguous, easy-to-type words for readable local parts (word-word-1234).
export const WORDS = (
  "amber apple arrow aspen atlas autumn badge bamboo basil beacon berry birch bison blaze bloom breeze brook cabin cactus " +
  "canyon cedar chalk cherry cider citrus clover cobalt comet coral cosmos cotton crane crisp crystal cypress daisy delta " +
  "denim dune eagle echo ember falcon fern fig fjord flint forest fossil fox frost galaxy garnet ginger glacier grove " +
  "harbor hazel heron honey indigo iris island ivory jade jasper juniper kayak kelp kiwi lagoon lake lark lava lemon " +
  "lilac lime linen lotus lunar maple marble meadow mango mesa mint mist moss nectar nova oak oasis ocean olive onyx " +
  "orbit orchid otter owl palm panda pearl pebble pepper pine plum polar poppy prairie quartz quill raven reef ridge " +
  "river robin ruby saffron sage salt sand satin sierra silver slate snow solar sparrow spruce stone storm summit sun " +
  "swift tango teal thistle thunder tide tiger topaz trail tulip tundra valley velvet violet walnut wave willow wind " +
  "winter wren yarrow zephyr zinc"
).split(" ");

export function readableLocalPart(): string {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(10000)).padStart(4, "0");
  return `${w()}-${w()}-${digits}`;
}

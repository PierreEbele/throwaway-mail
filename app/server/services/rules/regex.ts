/**
 * User-written regular expressions run on every incoming mail, so they are guarded against catastrophic
 * backtracking (ReDoS): short patterns only, no back-references, no nested quantifiers, at most one open-ended
 * repetition (see backtrackCost), and the input is cut to a bounded size before matching (an alias is at most 254
 * characters anyway).
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_INPUT_LENGTH = 320;

/** A quantified group that itself contains a quantifier: (a+)+, (\w*x)*, (a|b+){2,}… */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
/** Alternation inside a quantified group whose branches may overlap: (a|a)*, (\w|\d)+. */
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/**
 * Walks the pattern once and measures how much a backtracking engine may have to try.
 * - `nested`: a repeated group contains a repetition or an alternation, like ((a+))+ or (a|ab){2,}: the number of
 *   ways to match grows exponentially with the input.
 * - `factor`: upper bound on the number of ways the repetitions can share out the input, from one start position.
 *   With nothing nested, the matching cost is at most about start positions × factor × the pattern length, where
 *   start positions is 1 for an anchored pattern and MAX_INPUT_LENGTH otherwise. Each `*`, `+` or `{n,}` counts
 *   for MAX_INPUT_LENGTH + 1, `{n,m}` for its range + 1, `?` for 2. The product is taken across `|` branches too,
 *   which only over-estimates.
 */
export function backtrackCost(pattern: string): { nested: boolean; factor: number; anchored: boolean } {
  let factor = 1;
  let nested = false;
  let topLevelAlternation = false;
  // Per open group: whether it holds a repetition / an alternation.
  const groups: Array<{ quantified: boolean; alternation: boolean }> = [];
  // What the next quantifier would apply to: nothing, a single atom, or the group that was just closed.
  let target: null | "atom" | { quantified: boolean; alternation: boolean } = null;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      i += 2;
      target = "atom";
      continue;
    }
    if (c === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") i += pattern[i] === "\\" ? 2 : 1;
      i++;
      target = "atom";
      continue;
    }
    if (c === "(") {
      i += /^\((?:\?(?::|<[A-Za-z_$][\w$]*>|<?[=!]))?/.exec(pattern.slice(i))![0].length;
      groups.push({ quantified: false, alternation: false });
      target = null;
      continue;
    }
    if (c === ")") {
      const g = groups.pop() ?? { quantified: false, alternation: false };
      const parent = groups[groups.length - 1];
      if (parent) {
        parent.quantified ||= g.quantified;
        parent.alternation ||= g.alternation;
      }
      target = g;
      i++;
      continue;
    }
    const braces = c === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (target && (c === "*" || c === "+" || c === "?" || braces)) {
      let choices: number;
      if (braces) {
        const min = Number(braces[1]);
        const max = braces[2] === undefined ? min : braces[3] === "" ? Infinity : Number(braces[3]);
        choices = Math.min(max - min, MAX_INPUT_LENGTH) + 1;
        i += braces[0].length;
      } else {
        choices = c === "?" ? 2 : MAX_INPUT_LENGTH + 1;
        i++;
      }
      if (pattern[i] === "?") i++; // lazy form: same cost
      if (target !== "atom" && (target.quantified || (target.alternation && c !== "?"))) nested = true;
      factor *= Math.max(1, choices);
      const g = groups[groups.length - 1];
      if (g) g.quantified = true;
      target = null;
      continue;
    }
    if (c === "|") {
      const g = groups[groups.length - 1];
      if (g) g.alternation = true;
      else topLevelAlternation = true;
      target = null;
    } else target = c === "^" || c === "$" ? null : "atom";
    i++;
  }
  // `^…` with no top-level `|` can only match at the start of the input, so it is tried from one position only.
  return { nested, factor, anchored: pattern.startsWith("^") && !topLevelAlternation };
}

/**
 * Budget for start positions × factor: an unanchored pattern gets one open-ended repetition plus a couple of `?`, an
 * anchored one (^…) two open-ended repetitions. Matching then stays within a few milliseconds whatever the input.
 */
export const MAX_BACKTRACK_STEPS = MAX_INPUT_LENGTH * (MAX_INPUT_LENGTH + 1) * 2;

/** Why this pattern is refused (plain English), or null when it is safe to use. */
export function patternProblem(pattern: string): string | null {
  if (!pattern) return "The pattern is empty.";
  if (pattern.length > MAX_PATTERN_LENGTH) return `The pattern is longer than ${MAX_PATTERN_LENGTH} characters.`;
  if (/\\[1-9]|\\k</.test(pattern)) return "Back-references (\\1, \\k<name>) are not allowed.";
  if (/\(\?<?[=!]/.test(pattern)) return "Look-ahead and look-behind are not allowed.";
  const cost = backtrackCost(pattern);
  if (NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern) || cost.nested)
    return "Repeated groups that contain repetition, like (a+)+ or (a|b)*, are not allowed: they can make matching extremely slow.";
  if ((cost.anchored ? 1 : MAX_INPUT_LENGTH) * cost.factor > MAX_BACKTRACK_STEPS)
    return "Too much repetition: use at most one open-ended repetition (*, + or {n,}), or two in a pattern that starts with ^, and only short {n,m} ranges besides. Patterns like .*a.*b can make matching extremely slow.";
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    return `Not a valid regular expression: ${(e as Error).message}`;
  }
  return null;
}

const cache = new Map<string, RegExp | null>();

function compiled(pattern: string): RegExp | null {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = patternProblem(pattern) ? null : new RegExp(pattern, "i");
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re;
}

/** Whether a pattern passes today's checks (a rule saved before a check was tightened may hold one that does not). */
export function usablePattern(pattern: string): boolean {
  return compiled(pattern) !== null;
}

/** Tests a (checked) pattern against the start of `input`; an unsafe or invalid pattern never matches. */
export function safeTest(pattern: string, input: string): boolean {
  const re = compiled(pattern);
  return re ? re.test(input.slice(0, MAX_INPUT_LENGTH)) : false;
}

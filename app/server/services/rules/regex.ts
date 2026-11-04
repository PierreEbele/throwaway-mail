/**
 * User-written regular expressions run on every incoming mail, so they are guarded against catastrophic
 * backtracking (ReDoS): short patterns only, no back-references, no nested quantifiers, and the input is cut to a
 * bounded size before matching (an alias is at most 254 characters anyway).
 */

export const MAX_PATTERN_LENGTH = 200;
export const MAX_INPUT_LENGTH = 320;

/** A quantified group that itself contains a quantifier: (a+)+, (\w*x)*, (a|b+){2,}… */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/;
/** Alternation inside a quantified group whose branches may overlap: (a|a)*, (\w|\d)+. */
const QUANTIFIED_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Why this pattern is refused (plain English), or null when it is safe to use. */
export function patternProblem(pattern: string): string | null {
  if (!pattern) return "The pattern is empty.";
  if (pattern.length > MAX_PATTERN_LENGTH) return `The pattern is longer than ${MAX_PATTERN_LENGTH} characters.`;
  if (/\\[1-9]|\\k</.test(pattern)) return "Back-references (\\1, \\k<name>) are not allowed.";
  if (/\(\?<?[=!]/.test(pattern)) return "Look-ahead and look-behind are not allowed.";
  if (NESTED_QUANTIFIER.test(pattern) || QUANTIFIED_ALTERNATION.test(pattern))
    return "Repeated groups that contain repetition, like (a+)+ or (a|b)*, are not allowed: they can make matching extremely slow.";
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    return `Not a valid regular expression: ${(e as Error).message}`;
  }
  return null;
}

const cache = new Map<string, RegExp | null>();

/** Tests a (checked) pattern against the start of `input`; an unsafe or invalid pattern never matches. */
export function safeTest(pattern: string, input: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = patternProblem(pattern) ? null : new RegExp(pattern, "i");
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re ? re.test(input.slice(0, MAX_INPUT_LENGTH)) : false;
}

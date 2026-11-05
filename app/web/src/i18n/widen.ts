/** Shape of a catalog derived from the English one: same keys, strings as `string`, functions with the same parameters. */
export type Widen<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R extends string ? string : R
  : T extends string
    ? string
    : { [K in keyof T]: Widen<T[K]> };

/** Declares one area of the catalog: the French half must have exactly the keys of the English half. */
export function area<E>(en: E, fr: Widen<E>) {
  return { en, fr };
}

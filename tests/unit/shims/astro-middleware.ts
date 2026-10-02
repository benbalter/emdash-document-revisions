// Stand-in for Astro's virtual `astro:middleware` module in the unit project:
// defineMiddleware only types its argument.
export const defineMiddleware = <T>(fn: T): T => fn;

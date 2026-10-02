// Astro components are compiled by the host site; tsc only needs their shape.
declare module "*.astro" {
	const Component: (props: Record<string, unknown>) => unknown;
	export default Component;
}

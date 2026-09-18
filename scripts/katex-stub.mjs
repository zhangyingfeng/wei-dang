// Stand-in for the real `katex` package, swapped in at sidecar-build time
// (see build-sidecar-compile.mjs's onResolve plugin) so the compiled binary
// doesn't carry katex's real weight. markdown-docx (our fork, same one
// zhi-dang uses) only calls katex.renderToString() when its caller passes
// `math.engine === "katex"` as an option — exporter.ts's writeWordDoc calls
// markdownDocx() with no options at all, so that branch is unreachable from
// this codebase, not just unlikely. If it were ever hit anyway, throwing
// loudly here is better than silently returning garbage into someone's
// exported .docx.
export default {
  renderToString() {
    throw new Error("katex-stub: math rendering was not expected to be reachable — writeWordDoc never sets math.engine");
  },
};

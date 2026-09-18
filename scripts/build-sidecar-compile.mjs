// The actual compile step for build-sidecar.sh — split out into its own
// script because plugins (the katex stub) aren't available to `bun build`'s
// CLI form, only to the programmatic Bun.build() API. Takes the entry file
// and output path as argv.
const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bun scripts/build-sidecar-compile.mjs <entry> <outfile>");
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [entry],
  compile: { outfile },
  plugins: [
    {
      name: "stub-katex",
      setup(build) {
        // markdown-docx (a dependency reachable from exporter.ts's Word
        // conversion) imports katex unconditionally; see katex-stub.mjs for
        // why this is safe to swap out.
        build.onResolve({ filter: /^katex$/ }, () => ({
          path: new URL("./katex-stub.mjs", import.meta.url).pathname,
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

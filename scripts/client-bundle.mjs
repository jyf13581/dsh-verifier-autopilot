// One definition of the DSH browser bundle (review R6 6.2), shared by the two
// build paths so they cannot drift apart again:
//   - tsdown.config.ts  (`npm run build:client`: CI and portable checkouts)
//   - scripts/build.sh  (installed-runtime fallback without the lockfile
//                        toolchain; bundles with esbuild via esbuildClientOptions)
//
// Before R6 the two disagreed on externals (build.sh would have inlined
// cordis/ui-slots/client-runtime if the client ever imported them) and on the
// wrapper: build.sh declared `var module` / `var exports` at script top level,
// OUTSIDE the loader factory, i.e. as page globals (window.module,
// window.exports) that any later UMD-style script would take for a CommonJS
// environment. The CommonJS shim below lives inside the factory.

export const PLUGIN_ID = '@dsh-external/dsh-verifier-autopilot'
export const CLIENT_ENTRY = 'src/client/index.ts'

/** Provided by the DSH web runtime through the factory's `require`. */
export const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

export const WRAPPER_BANNER = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {'
export const WRAPPER_INTRO = 'var module = { exports: {} }; var exports = module.exports;'
export const WRAPPER_FOOTER = 'return module.exports; } });'

/** esbuild options equivalent to tsdown.config.ts (same entry, externals,
 *  wrapper, NODE_ENV). */
export function esbuildClientOptions(outfile) {
  return {
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    external: [...CLIENT_EXTERNALS],
    outfile,
    sourcemap: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    banner: { js: WRAPPER_BANNER + '\n' + WRAPPER_INTRO },
    footer: { js: WRAPPER_FOOTER },
    logLevel: 'warning',
  }
}

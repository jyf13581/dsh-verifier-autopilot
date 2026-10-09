import type { UserConfig } from 'tsdown'
// Entry, externals and wrapper are shared with scripts/build.sh's esbuild
// fallback (review R6 6.2); edit them in scripts/client-bundle.mjs.
import {
  CLIENT_ENTRY, CLIENT_EXTERNALS, WRAPPER_BANNER, WRAPPER_FOOTER, WRAPPER_INTRO,
} from './scripts/client-bundle.mjs'

const clientBundle: UserConfig = {
  entry: { client: CLIENT_ENTRY },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: WRAPPER_BANNER,
    footer: WRAPPER_FOOTER,
    intro: WRAPPER_INTRO,
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]

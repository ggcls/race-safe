import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  fixedExtension: true,
  platform: 'neutral',
  target: 'es2022',
  clean: true,
  dts: { oxc: true },
})

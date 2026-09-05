import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built bundle loads correctly under Electron's
  // file:// production loading, in addition to the existing http(s) web deploy.
  base: './',
  // Native Capacitor/Gradle build dirs under android/ios aren't source — watching
  // them crashes Vite's file watcher on Windows (ENOENT/UNKNOWN scanning their
  // build output), which kills `npm run dev` entirely.
  server: { watch: { ignored: ['**/android/**', '**/ios/**'] } },
  // Pure-logic files only (tournament engine) — no DOM needed, so plain Node is
  // both correct and faster than a jsdom environment. Co-located *.test.js next
  // to source, no separate __tests__ tree.
  test: {
    environment: 'node',
    include: ['src/lib/**/*.test.js'],
  },
  build: {
    rollupOptions: {
      output: {
        // Only loaded once a Supabase client is actually created (getSupabase in
        // lib/cloud.js), but pulling it into its own chunk keeps it out of the
        // main bundle's parse/eval cost on first paint.
        manualChunks(id) {
          if (id.includes('@supabase/supabase-js')) return 'supabase'
        },
      },
    },
  },
})

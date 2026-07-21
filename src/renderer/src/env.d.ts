/// <reference types="vite/client" />

import type { SeekrApi } from '../../preload'

declare global {
  interface Window {
    seekr: SeekrApi
  }
}

export {}

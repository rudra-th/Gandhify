# Gandhify

**Turn any photo into Mahatma Gandhi.**

Revolutionary technology that takes any image and turns it into the Mahatma — your eyes become his, pixel by pixel. Face detection and the output render all happen locally in the browser, so no photo ever leaves your device.

## Live App

**[gandhify.netlify.app](https://gandhify.netlify.app/)** — installable as a PWA.

## Features

- **Your eyes become his — pixel by pixel** — automatic face detection and morphing
- **100% in-browser** — nothing is ever uploaded to a server
- **Two face-crop sizes** — `96px` for a quick pass, `128px` for the detailed one
- **Export as PNG or GIF** — save the result or share it
- **Morph film** — a playable morph animation, with reverse
- **Installable PWA** — works offline after first visit

## Tech Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript |
| Build | Vite |
| GIF encoding | `gifenc` |
| Hosting | Netlify |

## Running locally

```bash
npm install
npm run dev    # http://localhost:5173
npm run build  # production build to ./dist
```

## Browser support

Modern Chrome, Edge, Firefox and Safari. Audio is optional and generated on-device; analytics (if enabled in settings) is fully opt-out.

## Privacy

Face detection and rendering are computed entirely on your device. No photo is ever uploaded, and the optional analytics can be switched off completely.
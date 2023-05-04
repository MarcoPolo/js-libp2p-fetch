// import React from 'react'
// import ReactDOMClient from 'react-dom/client'

// import './app.css'
// import App from './app.tsx'

// set up debug logging if you want.
import debug from 'debug'
debug.enable('libp2p:*:error,-*:trace,libp2p:webtransport')

const sw = await navigator.serviceWorker.register(new URL('sw.ts', import.meta.url))
console.log('sw: ', sw)

// always update the service worker
void sw.update()

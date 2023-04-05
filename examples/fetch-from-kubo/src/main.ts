/* eslint-disable no-console */
import './style.css'
import { multiaddr } from '@multiformats/multiaddr'
import { setup as libp2pSetup } from './libp2p'
import { fetchViaDuplex } from '@libp2p/fetch'

localStorage.debug = '*'

declare global {
  interface Window {
    fetchBtn: HTMLButtonElement
    connectBtn: HTMLButtonElement
    peerInput: HTMLInputElement
    cidInput: HTMLInputElement
    statusEl: HTMLParagraphElement
    downloadEl: HTMLAnchorElement
    downloadCidWrapperEl: HTMLDivElement
    connlistWrapperEl: HTMLDivElement
    connlistEl: HTMLUListElement
  }
}

(async function () {
  const { libp2p } = await libp2pSetup()
  window.connectBtn.onclick = async () => {
    let a = window.peerInput.value
    if (a === '') {
      a = window.peerInput.placeholder
    }
    const ma = multiaddr(a)
    await libp2p.dial(ma)
  }

  libp2p.addEventListener('peer:connect', (_connectionEvent) => {
    updateConnList()
  })
  libp2p.addEventListener('peer:disconnect', (_connection) => {
    updateConnList()
  })

  function updateConnList (): void {
    const addrs = libp2p.getConnections().map(c => c.remoteAddr.toString())
    if (addrs.length > 0) {
      window.downloadCidWrapperEl.hidden = false
      window.connlistWrapperEl.hidden = false
      window.connlistEl.innerHTML = ''
      addrs.forEach(a => {
        const li = document.createElement('li')
        li.innerText = a
        window.connlistEl.appendChild(li)
      })
    } else {
      window.downloadCidWrapperEl.hidden = true
      window.connlistWrapperEl.hidden = true
      window.connlistEl.innerHTML = ''
    }
  }

  window.fetchBtn.onclick = async () => {
    const connection = libp2p.getConnections()[0]
    // Try to fetch a CID via fetchViaDuplex
    void (async () => {
      const s = await connection.newStream('/libp2p-http')
      const fetch = fetchViaDuplex(s)
      const resp = await fetch(new Request('https://example.com/ipfs/bafybeidatpz2hli6fgu3zul5woi27ujesdf5o5a7bu622qj6ugharciwjq/static/media/ipfs-logo.e2de4d07.svg'))
      // Or a raw request:
      // const resp = await fetch(new Request('https://example.com/ipfs/bafybeidatpz2hli6fgu3zul5woi27ujesdf5o5a7bu622qj6ugharciwjq?format=raw'))
      console.log('Response: ', resp)
      const text = await resp.text()
      console.log('Response body: ', text)

      // Create new iframe
      const iframe = document.createElement('iframe')
      iframe.setAttribute('style', 'width: 100%; height: 100%;')
      iframe.srcdoc = text
      // @ts-expect-error
      window.iframeWrapperEl.appendChild(iframe)
    })().catch((err: any) => { console.error(err) })
  }
// eslint-disable-next-line no-console
})().catch(err => { console.error(err) })

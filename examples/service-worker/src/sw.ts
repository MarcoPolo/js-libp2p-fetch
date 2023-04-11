/* eslint-disable @typescript-eslint/strict-boolean-expressions */

import { fetchViaDuplex } from '@marcopolo_/libp2p-fetch'
import { webTransport } from '@libp2p/webtransport'
import { noise } from '@chainsafe/libp2p-noise'
import { createLibp2p, type Libp2p } from 'libp2p'
import { createBitswap } from 'ipfs-bitswap'
import { MemoryBlockstore } from 'blockstore-core/memory'
import { multiaddr } from '@multiformats/multiaddr'

self.addEventListener('install', event => {
  console.log('sw installing')
  // @ts-expect-error missing skipWaiting
  self.skipWaiting()
})

let libp2p: Libp2p

self.addEventListener('activate', event => {
  void libp2pSetup().then(res => {
    libp2p = res.libp2p
  }).catch(err => {
    console.error('sw failed to start', err)
  })
  console.log('sw activating')
})

const fetchHandler = async (event: FetchEvent): Promise<Response> => {
  const url = new URL(event.request.url)
  const connectTo = url.hash.substring(1)
  if (libp2p == null) {
    await libp2pSetup().then(res => {
      libp2p = res.libp2p
    }).catch(err => {
      console.error('sw failed to start', err)
    })
  }

  const allConns = libp2p.getConnections()
  try {
    const conn = connectTo != null && connectTo.length > 0 ? await libp2p.dial(multiaddr(connectTo)) : (allConns.length > 0 ? allConns[0] : null)

    if (conn != null && allConns.length === 0) {
    // Our first connection. Keep a ping around to keep it alive
      const pingInterval = setInterval(() => {
        libp2p.ping(multiaddr(connectTo)).catch(err => {
          console.error('sw ping failed', err)
          clearInterval(pingInterval)
        })
      }, 2000)
      console.log('sw connected to', conn.remoteAddr.toString())
    }

    if (url.host === location.host && libp2p != null && conn != null) {
      const s = await conn.newStream('/libp2p-http')
      const fetch = fetchViaDuplex(s)
      const resp = await fetch(event.request)
      return resp
    }
  } catch (err) {
    console.error('sw failed to connect', err)
  }

  return await fetch(event.request)
}

self.addEventListener('fetch', event => {
  console.log('sw fetch', event.request.url)
  event.respondWith(fetchHandler(event))
})

type Bitswap = ReturnType<typeof createBitswap>

export async function libp2pSetup (): Promise<{ libp2p: Libp2p, bitswap: Bitswap }> {
  const store = new MemoryBlockstore()

  const node = await createLibp2p({
    transports: [webTransport()],
    connectionEncryption: [noise()]

  })

  await node.handle('/libp2p-http', (streamData) => {
    // We don't do anything here. We just need this to set outbound stream limit
    streamData.stream.close()
  }, {
    maxInboundStreams: 1,
    maxOutboundStreams: 1024
  })

  await node.start()

  const bitswap = createBitswap(node, store)
  await bitswap.start()

  return { libp2p: node, bitswap }
}

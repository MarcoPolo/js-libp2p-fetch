# @libp2p/fetch <!-- omit in toc -->

> Fetch API on js-libp2p streams

## Table of contents <!-- omit in toc -->

- [Install](#install)
- [Libp2p Usage Example](#libp2p-usage-example)
- [License](#license)
- [Contribution](#contribution)

## Install

```console
npm i @libp2p/fetch
```

## Libp2p Usage Example

```js
import { createLibp2pNode } from 'libp2p'
import { webTransport } from '@libp2p/webtransport'
import { noise } from 'libp2p-noise'

const node = await createLibp2pNode({ /* ... */ })
const { stream } = await node.dialProtocol(remotePeerId, '/libp2p-http')

const respPromise = await fetchViaDuplex(stream)(new Request('http://example.com/'))
```

## License

Licensed under either of

- Apache 2.0, ([LICENSE-APACHE](LICENSE-APACHE) / <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT ([LICENSE-MIT](LICENSE-MIT) / <http://opensource.org/licenses/MIT>)

## Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.

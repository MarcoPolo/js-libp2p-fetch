# `fetch` over libp2p

This example shows how to access the IPFS HTTP gateway api over a libp2p stream
using `libp2p-fetch`. We just make a GET request and get the content. Easy
peasy!

The target should be a kubo node that has the changes from this branch:
https://github.com/MarcoPolo/go-ipfs/tree/marco/http-over-webtransport


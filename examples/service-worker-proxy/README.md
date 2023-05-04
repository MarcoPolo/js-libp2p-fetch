# Service worker proxy

This is an example of proxying all request over a libp2p WebTransport
connection. The proxy is specified in the url after the `#`, and all requests
will be made to the endpoint.

See the proxy-server folder for the implementation of the proxy server.


# Example

1. Start the proxy server `cd go-libp2p-proxy-server && go run . -proxy-target
   "https://text.npr.org" -allowed-peers=*`. It'll print the proxy's multiaddr.
2. Start the webapp `npm run start`
3. Copy the proxy address, and go to `localhost:3000/#<proxy-multiaddr>`

# Local HTTP servers and security

Be warned that if you proxy a local HTTP server you could open that server up to
the internet if you listen on a public IP address. If you do this, it's
recommended to be explicit in the allowed peer ids.

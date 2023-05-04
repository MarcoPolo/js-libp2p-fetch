package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"flag"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/multiformats/go-multiaddr"
)

const ID = "/http/proxy/0.0.1"

var l = log.Default()

func main() {
	allowedPeersParam := flag.String("allowed-peers", "", "A comma separated list of allowed peers")
	proxyTarget := flag.String("proxy-target", "", "target http server to proxy to")
	listeningAddrStrings := flag.String("addrs", "/ip4/127.0.0.1/udp/60496/quic-v1/webtransport", "Comma separated list of multiaddrs. Use * to allow any peer.")
	flag.Parse()
	if *allowedPeersParam == "" {
		l.Fatal("A comma separated list of allowed peers must be set. For example: -allowed-peers=12D3KooWN3C2tC1hXfk4rWfZtHT5GZerYDyN1BXKh2pTCe1Ccha8. Or use -allowed-peers=* to allow any peer")
	}
	if *proxyTarget == "" {
		l.Fatal("proxy target must be set")
	}
	allowedPeers := strings.Split(*allowedPeersParam, ",")

	opts := []libp2p.Option{libp2p.ListenAddrStrings(strings.Split(*listeningAddrStrings, ",")...)}
	keyBytes, err := ioutil.ReadFile("./private.key")
	if err == nil {
		if err != nil {
			panic(err)
		}
		key, err := crypto.UnmarshalPrivateKey(keyBytes)
		if err != nil {
			panic(err)
		}
		opts = append(opts, libp2p.Identity(key))
	} else {
		key, _, err := crypto.GenerateEd25519Key(rand.Reader)
		if err != nil {
			panic(err)
		}
		opts = append(opts, libp2p.Identity(key))

		keyBytes, err = crypto.MarshalPrivateKey(key)
		if err != nil {
			panic(err)
		}
		err = ioutil.WriteFile("./private.key", keyBytes, 0600)
		if err != nil {
			panic(err)
		}
	}

	h, err := libp2p.New(opts...)
	if err != nil {
		panic(err)
	}

	fmt.Println("Listening on:")
	for _, a := range h.Addrs() {
		fmt.Println(a.Encapsulate(multiaddr.StringCast("/p2p/" + h.ID().String())))
	}

	targetUrl, err := url.Parse(*proxyTarget)
	if err != nil {
		log.Fatal(err)
	}

	// reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetUrl)
	proxy.Director = func(req *http.Request) {
		req.URL.Scheme = targetUrl.Scheme
		req.URL.Host = targetUrl.Host
		req.Host = targetUrl.Host
	}

	// Create a new HTTP server and set the handler to the proxy
	server := &http.Server{
		Addr:    ":8082",
		Handler: proxy,
	}

	go server.ListenAndServe()

	h.SetStreamHandler(ID, func(s network.Stream) {
		defer s.Close()

		remotePeer := s.Conn().RemotePeer().String()
		allowed := false
		if allowedPeers[0] == "*" {
			allowed = true
		}
		for _, p := range allowedPeers {
			if p == remotePeer {
				allowed = true
			}
		}
		if !allowed {
			l.Println("Got a new stream from", remotePeer, "but it is not an allowed peer. If it should be add it to the flag -allowed-peers")
			return
		}

		// Catch panics and log
		defer func() {
			if err := recover(); err != nil {
				log.Println("panic occurred:", err)
			}
		}()

		b := bufio.NewReader(s)
		req, err := http.ReadRequest(b)
		if err != nil {
			l.Println("error reading request:", err)
		}

		wrappedRespWriter := &wrappedResponseWriter{
			resp: http.Response{
				Header: make(http.Header),
			},
		}
		proxy.ServeHTTP(wrappedRespWriter, req)

		resp := wrappedRespWriter.Build()
		err = resp.Write(s)
		if err != nil {
			l.Println("error proxying request:", err)
			return
		}
	})

	select {}
}

type wrappedResponseWriter struct {
	resp http.Response
	buf  bytes.Buffer
}

func (w *wrappedResponseWriter) Build() http.Response {
	r := w.resp
	r.Body = io.NopCloser(&w.buf)
	return r
}

func (w *wrappedResponseWriter) Write(b []byte) (int, error) {
	return w.buf.Write(b)
}

func (w *wrappedResponseWriter) WriteHeader(statusCode int) {
	w.resp.StatusCode = statusCode
}

func (w *wrappedResponseWriter) Header() http.Header {
	return w.resp.Header
}

var _ http.ResponseWriter = &wrappedResponseWriter{}

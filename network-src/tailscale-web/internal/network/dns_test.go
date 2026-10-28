//go:build js

package network

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall/js"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/net/tsdial"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

func testNetworkMap() *netmap.NetworkMap {
	return &netmap.NetworkMap{
		SelfNode: (&tailcfg.Node{
			Name:      "browser.tail123.ts.net.",
			Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.1/32")},
		}).View(),
		Peers: []tailcfg.NodeView{(&tailcfg.Node{
			Name:      "peer.custom.example.org.",
			Hostinfo:  (&tailcfg.Hostinfo{Hostname: "machine.custom.example.org"}).View(),
			Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.2/32")},
		}).View()},
		DNS: tailcfg.DNSConfig{
			Routes:       map[string][]*dnstype.Resolver{".": nil, "Corp.Example.Org.": nil},
			Domains:      []string{"search.example.org"},
			ExtraRecords: []tailcfg.DNSRecord{{Name: "extra.example.org.", Value: "100.64.0.3"}},
		},
	}
}

func TestDNSRoutingProtectsPrivateNames(t *testing.T) {
	nm := testNetworkMap()
	for _, host := range []string{
		"100.64.0.2", "1.1.1.1", "fd7a:115c:a1e0::2", "peer", "peer.",
		"browser.tail123.ts.net", "MISSING.TAIL123.TS.NET.", "other.other-tailnet.ts.net",
		"peer.custom.example.org", "machine.custom.example.org", "extra.example.org",
		"missing.corp.example.org", "CORP.EXAMPLE.ORG.", "missing.search.example.org",
		"printer.local", "missing.internal", "device.home.arpa", "hidden.onion",
	} {
		t.Run(host, func(t *testing.T) {
			if !useTailnetDNS(host, nm) {
				t.Fatalf("private or literal host %q would use public DNS", host)
			}
		})
	}
	for _, host := range []string{"public.example.org", "notcorp.example.org", "corp.example.org.public.example", "cloudflare.com"} {
		if useTailnetDNS(host, nm) {
			t.Errorf("public host %q unexpectedly classified as private", host)
		}
	}
	if !useTailnetDNS("public.example.org", nil) {
		t.Error("a missing network map must not permit public DNS")
	}
}

func TestDNSModeValidationAndReadiness(t *testing.T) {
	for _, test := range []struct {
		mode   string
		exit   bool
		wantOK bool
	}{{DNSModeExitNode, false, true}, {DNSModeExitNode, true, true}, {DNSModeCloudflare, true, true}, {DNSModeCloudflare, false, false}, {"auto", true, false}, {"", true, false}} {
		if err := validateDNSMode(test.mode, test.exit); (err == nil) != test.wantOK {
			t.Errorf("validateDNSMode(%q, %v) = %v", test.mode, test.exit, err)
		}
	}
	for _, test := range []struct {
		state string
		ips   int
		key   bool
		ready bool
	}{{"Starting", 1, true, false}, {"NeedsMachineAuth", 1, true, false}, {"NeedsLogin", 1, true, false}, {"Running", 0, true, false}, {"Running", 1, false, false}, {"Running", 1, true, true}} {
		if got := backendReady(test.state, test.ips, test.key); got != test.ready {
			t.Errorf("backendReady(%q, %d, %v) = %v", test.state, test.ips, test.key, got)
		}
	}
	if !backendHasIdentity("Starting", true) || !backendHasIdentity("NeedsMachineAuth", true) || backendHasIdentity("NeedsLogin", true) || backendHasIdentity("Starting", false) {
		t.Error("restored or prompt-free authentication was classified incorrectly")
	}
}

func TestPrivateNXDOMAINDoesNotFallBack(t *testing.T) {
	base := &tsdial.Dialer{UseNetstackForIP: func(netip.Addr) bool { return true }}
	base.NetstackDialTCP = func(_ context.Context, dst netip.AddrPort) (net.Conn, error) {
		if dst != netip.MustParseAddrPort("100.64.0.10:1") {
			t.Errorf("private NXDOMAIN attempted a different resolver: %s", dst)
			return nil, errors.New("unexpected resolver")
		}
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			server.SetDeadline(time.Now().Add(5 * time.Second))
			req, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				t.Error(err)
				return
			}
			body, err := io.ReadAll(req.Body)
			req.Body.Close()
			if err != nil {
				t.Error(err)
				return
			}
			var query dnsmessage.Message
			if err := query.Unpack(body); err != nil {
				t.Error(err)
				return
			}
			answer := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true, RCode: dnsmessage.RCodeNameError}, Questions: query.Questions}
			wire, err := answer.Pack()
			if err != nil {
				t.Error(err)
				return
			}
			resp := &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1, Header: http.Header{"Content-Type": []string{"application/dns-message"}}, ContentLength: int64(len(wire)), Body: io.NopCloser(bytes.NewReader(wire))}
			resp.Write(server)
		}()
		return client, nil
	}
	base.NetstackDialUDP = base.NetstackDialTCP
	base.SetNetMap(testNetworkMap())
	base.SetExitDNSDoH("http://100.64.0.10:1/dns-query")
	base.SetSystemDialerForTest(failSystemDial(t))
	public, client := newPublicDownloadClient(base, testNetworkMap, func() bool { return true })
	t.Cleanup(client.CloseIdleConnections)
	t.Cleanup(public.PeerAPIHTTPClient().CloseIdleConnections)
	t.Cleanup(base.PeerAPIHTTPClient().CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.Transport.(*http.Transport).DialContext(ctx, "tcp4", "missing.corp.example.org:443")
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) || !dnsErr.IsNotFound {
		t.Fatalf("expected private NXDOMAIN without fallback, got %v", err)
	}
}

func TestDNSErrorGuidanceDoesNotLeakPrivateNames(t *testing.T) {
	nm := testNetworkMap()
	for _, test := range []struct {
		name, mode    string
		timeout, exit bool
		marker        string
	}{
		{"public.example.org", DNSModeExitNode, true, true, "[EXIT_NODE_DNS_TIMEOUT]"},
		{"public.example.org", DNSModeCloudflare, true, true, "[CLOUDFLARE_DNS_TIMEOUT]"},
		{"missing.corp.example.org", DNSModeCloudflare, true, true, ""},
		{"missing.corp.example.org", DNSModeExitNode, false, true, ""},
		{"missing.tail123.ts.net", DNSModeExitNode, true, true, ""},
		{"public.example.org", DNSModeExitNode, true, false, ""},
	} {
		dnsErr := &net.DNSError{Name: test.name, Err: "resolver unavailable", IsTimeout: test.timeout, IsNotFound: !test.timeout}
		wrapped := &url.Error{Op: "Get", URL: "https://" + test.name, Err: dnsErr}
		got := explainDownloadError(wrapped, test.mode, test.exit, nm)
		if !errors.Is(got, dnsErr) {
			t.Error("DNS error context was lost")
		}
		if test.marker != "" && !strings.HasPrefix(got.Error(), test.marker) {
			t.Errorf("missing marker %q: %v", test.marker, got)
		}
		if test.marker == "" && strings.Contains(strings.ToLower(got.Error()), "cloudflare") {
			t.Errorf("private, NXDOMAIN, or no-exit error suggests public DNS: %v", got)
		}
	}
}

// This fixture uses real Go HTTP, DNS wire encoding, and TLS over net.Pipe.
// Only the final userspace TCP callback is substituted, so the test exercises
// the same tsdial DoH path used by the shipped WASM without tailnet credentials.
type dnsFixture struct {
	t       *testing.T
	mu      sync.Mutex
	calls   []netip.AddrPort
	queries []string
	conns   []net.Conn
	cert    tls.Certificate
	roots   *x509.CertPool
}

func newDNSFixture(t *testing.T) *dnsFixture {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("1.1.1.1")}, DNSNames: []string{"public.example.org"},
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	f := &dnsFixture{t: t, cert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots: x509.NewCertPool()}
	f.roots.AddCert(cert)
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, c := range f.conns {
			c.Close()
		}
	})
	return f
}

func (f *dnsFixture) dial(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
	f.mu.Lock()
	f.calls = append(f.calls, dst)
	f.mu.Unlock()
	doh := dst == netip.MustParseAddrPort("1.1.1.1:443")
	if !doh && dst != netip.MustParseAddrPort("203.0.113.9:443") {
		return nil, fmt.Errorf("unexpected userspace destination %s", dst)
	}
	client, server := net.Pipe()
	f.mu.Lock()
	f.conns = append(f.conns, client, server)
	f.mu.Unlock()
	go f.serve(server, doh)
	return client, nil
}

func (f *dnsFixture) serve(conn net.Conn, doh bool) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	secure := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{f.cert}, NextProtos: []string{"http/1.1"}})
	if err := secure.Handshake(); err != nil {
		// The negative TLS test deliberately rejects this certificate.
		return
	}
	reader := bufio.NewReader(secure)
	for {
		req, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		body, err := io.ReadAll(req.Body)
		req.Body.Close()
		if err != nil {
			f.t.Error(err)
			return
		}
		response := []byte("downloaded through userspace TLS")
		contentType := "text/plain"
		if doh {
			if req.Method != "POST" || req.URL.Path != "/dns-query" || req.Header.Get("Content-Type") != "application/dns-message" {
				f.t.Errorf("unexpected DoH request: %s %s %q", req.Method, req.URL, req.Header.Get("Content-Type"))
				return
			}
			var query dnsmessage.Message
			if err := query.Unpack(body); err != nil {
				f.t.Error(err)
				return
			}
			answer := dnsmessage.Message{Header: dnsmessage.Header{ID: query.ID, Response: true, RecursionDesired: true, RecursionAvailable: true}, Questions: query.Questions}
			for _, q := range query.Questions {
				f.mu.Lock()
				f.queries = append(f.queries, q.Name.String())
				f.mu.Unlock()
				if q.Type == dnsmessage.TypeA {
					answer.Answers = append(answer.Answers, dnsmessage.Resource{
						Header: dnsmessage.ResourceHeader{Name: q.Name, Type: q.Type, Class: dnsmessage.ClassINET, TTL: 60},
						Body:   &dnsmessage.AResource{A: [4]byte{203, 0, 113, 9}},
					})
				}
			}
			response, err = answer.Pack()
			if err != nil {
				f.t.Error(err)
				return
			}
			contentType = "application/dns-message"
		}
		resp := &http.Response{StatusCode: 200, ProtoMajor: 1, ProtoMinor: 1,
			Header:        http.Header{"Content-Type": []string{contentType}},
			ContentLength: int64(len(response)), Body: io.NopCloser(bytes.NewReader(response)),
		}
		if err := resp.Write(secure); err != nil {
			return
		}
	}
}

func failSystemDial(t *testing.T) func(context.Context, string, string) (net.Conn, error) {
	return func(_ context.Context, network, addr string) (net.Conn, error) {
		t.Errorf("unexpected system dial: %s %s", network, addr)
		return nil, errors.New("system dial is forbidden")
	}
}

func TestPublicDNSOverHTTPSUsesUserspaceDialer(t *testing.T) {
	f := newDNSFixture(t)
	base := &tsdial.Dialer{UseNetstackForIP: func(netip.Addr) bool { return true }, NetstackDialTCP: f.dial}
	base.NetstackDialUDP = func(context.Context, netip.AddrPort) (net.Conn, error) {
		t.Error("unexpected UDP dial")
		return nil, errors.New("UDP forbidden")
	}
	base.SetSystemDialerForTest(failSystemDial(t))
	public, client := newPublicDownloadClient(base, testNetworkMap, func() bool { return true })
	public.SetSystemDialerForTest(failSystemDial(t))
	// Configure trust only on these independently owned test transports.
	public.PeerAPITransport().TLSClientConfig = &tls.Config{RootCAs: f.roots}
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: f.roots}
	t.Cleanup(client.CloseIdleConnections)
	t.Cleanup(public.PeerAPIHTTPClient().CloseIdleConnections)
	originalFetch := js.Global().Get("fetch")
	forbiddenFetch := js.FuncOf(func(js.Value, []js.Value) any {
		t.Error("browser fetch was called for a data or DNS request")
		return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New("browser fetch forbidden"))
	})
	js.Global().Set("fetch", forbiddenFetch)
	t.Cleanup(func() { js.Global().Set("fetch", originalFetch); forbiddenFetch.Release() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "https://public.example.org/data", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "downloaded through userspace TLS" {
		t.Fatalf("unexpected body %q", body)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queries) == 0 {
		t.Fatal("DNS wire request never reached the userspace callback")
	}
	for _, name := range f.queries {
		if name != "public.example.org." {
			t.Errorf("unexpected DNS query %q", name)
		}
	}
	var dns, data bool
	for _, addr := range f.calls {
		dns = dns || addr == netip.MustParseAddrPort("1.1.1.1:443")
		data = data || addr == netip.MustParseAddrPort("203.0.113.9:443")
	}
	if !dns || !data {
		t.Fatalf("expected encrypted DNS and data callbacks, got %v", f.calls)
	}
}

func TestPublicDNSVerifiesTLS(t *testing.T) {
	f := newDNSFixture(t)
	base := &tsdial.Dialer{NetstackDialTCP: f.dial}
	public := newPublicDNSDialer(base, func() bool { return true })
	public.SetSystemDialerForTest(failSystemDial(t))
	public.PeerAPITransport().TLSClientConfig = &tls.Config{RootCAs: x509.NewCertPool()}
	t.Cleanup(public.PeerAPIHTTPClient().CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := public.UserDial(ctx, "tcp4", "public.example.org:443")
	if conn != nil {
		conn.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "certificate signed by unknown authority") {
		t.Fatalf("untrusted DoH certificate was not rejected: %v", err)
	}
}

func TestPublicModeRetainsPrivateDNSAndExitGate(t *testing.T) {
	nm := testNetworkMap()
	var calls []netip.AddrPort
	base := &tsdial.Dialer{UseNetstackForIP: func(netip.Addr) bool { return true }}
	base.NetstackDialTCP = func(_ context.Context, dst netip.AddrPort) (net.Conn, error) {
		calls = append(calls, dst)
		return nil, errors.New("userspace sentinel")
	}
	base.NetstackDialUDP = base.NetstackDialTCP
	base.SetNetMap(nm)
	base.SetExitDNSDoH("http://100.64.0.10:1/dns-query")
	base.SetSystemDialerForTest(failSystemDial(t))
	exitSelected := true
	public, client := newPublicDownloadClient(base, func() *netmap.NetworkMap { return nm }, func() bool { return exitSelected })
	t.Cleanup(client.CloseIdleConnections)
	t.Cleanup(public.PeerAPIHTTPClient().CloseIdleConnections)
	t.Cleanup(base.PeerAPIHTTPClient().CloseIdleConnections)
	dial := client.Transport.(*http.Transport).DialContext
	for _, test := range []struct{ host, destination string }{
		{"peer.custom.example.org:443", "100.64.0.2:443"},
		{"extra.example.org:443", "100.64.0.3:443"},
		{"1.1.1.1:443", "1.1.1.1:443"},
		{"missing.corp.example.org:443", "100.64.0.10:1"},
		{"missing.tail123.ts.net:443", "100.64.0.10:1"},
		{"public.example.org:443", "1.1.1.1:443"},
	} {
		calls = nil
		_, err := dial(context.Background(), "tcp4", test.host)
		if err == nil {
			t.Fatal("expected sentinel dial failure")
		}
		if len(calls) == 0 {
			t.Fatalf("no callback for %q: %v", test.host, err)
		}
		for _, dst := range calls {
			if dst.String() != test.destination {
				t.Errorf("%q used %s, want %s", test.host, dst, test.destination)
			}
		}
	}
	exitSelected = false
	calls = nil
	_, err := dial(context.Background(), "tcp4", "public.example.org:443")
	if !errors.Is(err, errDNSModeNeedsExitNode) || len(calls) != 0 {
		t.Fatalf("DNS continued without an exit node: error=%v callbacks=%v", err, calls)
	}
}

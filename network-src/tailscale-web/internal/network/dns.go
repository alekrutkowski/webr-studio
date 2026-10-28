//go:build js

package network

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"tailscale.com/net/tsdial"
	"tailscale.com/types/netmap"
)

const (
	DNSModeExitNode   = "exit-node"
	DNSModeCloudflare = "cloudflare"
	cloudflareDoHURL  = "https://1.1.1.1/dns-query"
)

var errDNSModeNeedsExitNode = errors.New("Cloudflare DNS through Tailscale requires a selected exit node")

// newDownloadHTTPClient uses Go's HTTP/TLS implementation over the supplied
// userspace dialer. A non-nil DialContext also disables browser fetch in WASM.
func newDownloadHTTPClient(dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Transport: &http.Transport{DialContext: dial, IdleConnTimeout: 90 * time.Second},
		// Data downloads can take longer when their traffic travels over DERP.
		Timeout: 120 * time.Second,
	}
}

// newPublicDNSDialer owns its DNS cache and DoH transport. It must not change
// the backend's dialer: that dialer also serves Tailscale's own PeerAPI calls.
func newPublicDNSDialer(base *tsdial.Dialer, exitSelected func() bool) *tsdial.Dialer {
	d := &tsdial.Dialer{
		Logf:             base.Logf,
		UseNetstackForIP: func(netip.Addr) bool { return true },
		NetstackDialTCP: func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
			if !exitSelected() {
				return nil, errDNSModeNeedsExitNode
			}
			if base.NetstackDialTCP == nil {
				return nil, errors.New("Tailscale userspace TCP dialer is unavailable")
			}
			return base.NetstackDialTCP(ctx, dst)
		},
		NetstackDialUDP: func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
			if !exitSelected() {
				return nil, errDNSModeNeedsExitNode
			}
			if base.NetstackDialUDP == nil {
				return nil, errors.New("Tailscale userspace UDP dialer is unavailable")
			}
			return base.NetstackDialUDP(ctx, dst)
		},
	}
	// The literal address avoids a bootstrap DNS lookup. Go still verifies the
	// server's certificate against the embedded CA roots and the IP SAN.
	d.SetExitDNSDoH(cloudflareDoHURL)
	return d
}

func newPublicDownloadClient(base *tsdial.Dialer, currentMap func() *netmap.NetworkMap, exitSelected func() bool) (*tsdial.Dialer, *http.Client) {
	public := newPublicDNSDialer(base, exitSelected)
	client := newDownloadHTTPClient(func(ctx context.Context, network, addr string) (net.Conn, error) {
		if !exitSelected() {
			return nil, errDNSModeNeedsExitNode
		}
		nm := currentMap()
		if nm == nil {
			return nil, errors.New("Tailscale network map is not ready")
		}
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		// Decide on every dial, including redirects to another host. Unknown
		// names within private DNS suffixes stay with the tailnet resolver.
		if useTailnetDNS(host, nm) {
			return base.UserDial(ctx, network, addr)
		}
		public.SetNetMap(nm)
		return public.UserDial(ctx, network, addr)
	})
	return public, client
}

func (n *Network) hasSelectedExitNode() bool {
	return n.backend.Prefs().ExitNodeID() != ""
}

// SetDNSMode changes DNS for public HTTP downloads only. It never changes the
// tailnet's DNS preferences and never falls back to another resolver on error.
func (n *Network) SetDNSMode(mode string) error {
	n.downloadMu.Lock()
	defer n.downloadMu.Unlock()
	if err := validateDNSMode(mode, n.hasSelectedExitNode()); err != nil {
		return err
	}
	if mode == n.dnsMode {
		return nil
	}
	n.closeDownloadIdleLocked()
	n.dnsMode = mode
	n.resetPublicDownloadClientLocked()
	return nil
}

func validateDNSMode(mode string, exitSelected bool) error {
	switch mode {
	case DNSModeExitNode:
		return nil
	case DNSModeCloudflare:
		if exitSelected {
			return nil
		}
		return errDNSModeNeedsExitNode
	default:
		return fmt.Errorf("unsupported DNS mode %q; use %q or %q", mode, DNSModeExitNode, DNSModeCloudflare)
	}
}

// resetPublicDownloadClientLocked replaces DNS caches as well as HTTP
// connections when the mode or exit changes. Existing requests may finish.
func (n *Network) resetPublicDownloadClientLocked() {
	n.publicDNSDialer = nil
	n.publicHTTPClient = nil
	if n.dnsMode == DNSModeCloudflare {
		n.publicDNSDialer, n.publicHTTPClient = newPublicDownloadClient(n.dialer, n.backend.NetMap, n.hasSelectedExitNode)
	}
}

func (n *Network) closeDownloadIdleLocked() {
	if n.httpClient != nil {
		n.httpClient.CloseIdleConnections()
	}
	if n.publicHTTPClient != nil {
		n.publicHTTPClient.CloseIdleConnections()
	}
	if n.publicDNSDialer != nil {
		n.publicDNSDialer.PeerAPIHTTPClient().CloseIdleConnections()
	}
}

// Select a separate client for each mode so a previously pooled connection
// cannot silently override a user's DNS choice on the next Fetch call.
func (n *Network) downloadClient() (*http.Client, string, error) {
	n.downloadMu.Lock()
	defer n.downloadMu.Unlock()
	if n.dnsMode != DNSModeCloudflare {
		return n.httpClient, DNSModeExitNode, nil
	}
	if !n.hasSelectedExitNode() {
		return nil, DNSModeCloudflare, errDNSModeNeedsExitNode
	}
	if n.publicHTTPClient == nil {
		n.resetPublicDownloadClientLocked()
	}
	n.publicDNSDialer.SetNetMap(n.backend.NetMap())
	return n.publicHTTPClient, DNSModeCloudflare, nil
}

func canonicalDNSName(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, "."))
}

func hasDNSSuffix(host, suffix string) bool {
	suffix = strings.Trim(canonicalDNSName(suffix), ".")
	return suffix != "" && (host == suffix || strings.HasSuffix(host, "."+suffix))
}

// useTailnetDNS protects both known records and unknown private names. A
// control-plane root DNS route does not make every public name private.
func useTailnetDNS(host string, nm *netmap.NetworkMap) bool {
	host = canonicalDNSName(host)
	if _, err := netip.ParseAddr(host); err == nil {
		return true
	}
	if !strings.Contains(host, ".") || nm == nil {
		return true
	}
	for _, suffix := range []string{"ts.net", "tailscale.net", "local", "localhost", "localdomain", "internal", "lan", "home", "home.arpa", "onion", "invalid", "test", "in-addr.arpa", "ip6.arpa"} {
		if hasDNSSuffix(host, suffix) {
			return true
		}
	}
	if host == canonicalDNSName(nm.SelfName()) || hasDNSSuffix(host, nm.MagicDNSSuffix()) {
		return true
	}
	for _, peer := range nm.Peers {
		if host == canonicalDNSName(peer.Name()) || (peer.Hostinfo().Valid() && host == canonicalDNSName(peer.Hostinfo().Hostname())) {
			return true
		}
	}
	for _, rec := range nm.DNS.ExtraRecords {
		if host == canonicalDNSName(rec.Name) {
			return true
		}
	}
	for suffix := range nm.DNS.Routes {
		if hasDNSSuffix(host, suffix) {
			return true
		}
	}
	for _, suffix := range nm.DNS.Domains {
		if hasDNSSuffix(host, suffix) {
			return true
		}
	}
	return false
}

func explainDownloadError(err error, mode string, exitSelected bool, nm *netmap.NetworkMap) error {
	var dnsErr *net.DNSError
	if !errors.As(err, &dnsErr) || (!dnsErr.Timeout() && !errors.Is(err, context.DeadlineExceeded)) {
		return fmt.Errorf("request failed: %w", err)
	}
	if useTailnetDNS(dnsErr.Name, nm) {
		return fmt.Errorf("tailnet DNS lookup timed out; check your exit node and tailnet DNS configuration: %w", err)
	}
	if !exitSelected {
		return fmt.Errorf("DNS lookup timed out; select an exit node to download from public websites: %w", err)
	}
	if mode == DNSModeCloudflare {
		return fmt.Errorf("[CLOUDFLARE_DNS_TIMEOUT] Cloudflare DNS through the exit node timed out; check that the exit node can reach 1.1.1.1 over HTTPS, then reconnect: %w", err)
	}
	return fmt.Errorf("[EXIT_NODE_DNS_TIMEOUT] The DNS request through the exit node timed out. For public websites, choose \"Cloudflare through exit node\" in Networking, or reconnect your exit node: %w", err)
}

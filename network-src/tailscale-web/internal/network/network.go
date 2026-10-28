//go:build js

package network

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/adrianosela/tailscale-web/internal/listener"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/logpolicy"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/net/tsdial"
	"tailscale.com/tailcfg"
	"tailscale.com/tsd"
	"tailscale.com/types/logger"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

// Config holds configuration for the Tailscale node.
type Config struct {
	// Hostname is the name this device will appear as on the tailnet.
	Hostname string

	// StoragePrefix is the key namespace used by the default localStorage store.
	// Defaults to "tailscale-web". Keys are written as "{prefix}_{stateKey}".
	// Ignored when Store is set explicitly.
	StoragePrefix string

	// ControlURL overrides the Tailscale coordination server URL.
	// Defaults to the public Tailscale control server.
	ControlURL string

	// Store is the state store to use. If nil, defaults to localStorage when
	// available (browser), or an in-memory store otherwise.
	Store ipn.StateStore
}

// OnAuthRequired is called with the OAuth URL when interactive login is needed.
type OnAuthRequired func(url string)

// OnAuthComplete is called once the device is authenticated and connected.
type OnAuthComplete func()

// Network manages a Tailscale node running in the browser.
type Network struct {
	backend    *ipnlocal.LocalBackend
	engine     wgengine.Engine
	dialer     *tsdial.Dialer
	httpClient *http.Client
	stack      *netstack.Impl
	listeners  *listener.Registry

	downloadMu       sync.Mutex
	dnsMode          string
	publicDNSDialer  *tsdial.Dialer
	publicHTTPClient *http.Client
}

// PingResult is the result of an ICMP connectivity probe.
type PingResult struct {
	Alive bool
	RttMs float64
	// NodeName is the MagicDNS name of the destination peer.
	NodeName string
	// NodeIP is the Tailscale IP of the destination.
	NodeIP string
	// Endpoint is the direct UDP endpoint used, if a direct path was established.
	Endpoint string
	// DERPRegionCode is the DERP relay region (e.g. "nyc") if traffic was relayed.
	DERPRegionCode string
	// Err holds the error reason when Alive is false.
	Err string
}

// FetchOptions mirrors the subset of the Fetch API init object we support.
type FetchOptions struct {
	Method    string
	Headers   map[string]string
	BodyBytes []byte
}

// FetchResponse is the result of a Fetch call.
type FetchResponse struct {
	Status     int
	StatusText string
	Headers    map[string]string
	Body       []byte
}

// ExitNode represents a peer that is advertising exit-node capability.
type ExitNode struct {
	// ID is the stable node ID; pass to SetExitNode to activate it.
	ID string
	// HostName is the machine's hostname.
	HostName string
	// DNSName is the MagicDNS FQDN (ends with a dot).
	DNSName string
	// TailscaleIP is the primary Tailscale IPv4 address of the node.
	TailscaleIP string
	// Active reports whether this node is the currently selected exit node.
	Active bool
	// Online reports whether the node is currently reachable.
	Online bool
	// OS is the operating system reported by the peer.
	OS string
	// Expired reports an expired device key, even if the peer is still listed.
	Expired bool
}

// Prefs contains the subset of Tailscale preferences exposed by this library.
type Prefs struct {
	// AcceptRoutes reports whether subnet routes advertised by peers are accepted.
	AcceptRoutes bool
	// ExitNodeID is the stable node ID of the currently selected exit node,
	// or empty if no exit node is active.
	ExitNodeID string
	// DNSMode selects exit-node DNS, or opt-in public DNS through that exit node.
	DNSMode string
}

// Connect starts a Tailscale node and returns a ready Network.
// If the node has persisted state from a previous session it reconnects
// automatically; otherwise it triggers the OAuth flow via onAuthRequired.
func Connect(ctx context.Context, cfg Config, onAuthRequired OnAuthRequired, onAuthComplete OnAuthComplete) (*Network, error) {
	netns.SetEnabled(false)
	logf := logger.Logf(log.Printf)

	log.Println("tailscale-web: starting...")

	sys := tsd.NewSystem()
	sys.Set(resolveStore(cfg, logf))

	dialer := &tsdial.Dialer{Logf: logf}

	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create WireGuard engine: %w", err)
	}
	sys.Set(eng)

	stack, err := newNetstack(logf, sys, eng, dialer)
	if err != nil {
		return nil, err
	}

	lpc := logpolicy.NewConfig(logtail.CollectionNode)
	backend, err := ipnlocal.NewLocalBackend(logf, lpc.PublicID, sys, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to create backend: %w", err)
	}

	if err := stack.Start(backend); err != nil {
		return nil, fmt.Errorf("failed to start netstack: %w", err)
	}

	listeners := listener.New()

	n := &Network{
		backend:    backend,
		engine:     eng,
		dialer:     dialer,
		stack:      stack,
		httpClient: newDownloadHTTPClient(dialer.UserDial),
		dnsMode:    DNSModeExitNode,
		listeners:  listeners,
	}

	stack.GetTCPHandlerForFlow = listeners.TCPHandler()

	loginURLCh := make(chan string, 1)
	backend.SetNotifyCallback(notifyCallback(onAuthRequired, loginURLCh))

	if err := backend.Start(ipn.Options{UpdatePrefs: buildPrefs(cfg)}); err != nil {
		backend.Shutdown()
		return nil, fmt.Errorf("failed to start backend: %w", err)
	}

	if ok := checkPersistedState(backend, onAuthComplete); ok {
		return n, nil
	}
	// An authenticated node can still be establishing its DERP connection.
	// Wait for the transport instead of forcing a new login for restored state.
	if backendHasIdentity(backend.Status().BackendState, !backend.NodeKey().IsZero()) {
		if err := waitForAuth(ctx, backend, onAuthComplete); err != nil {
			backend.Shutdown()
			return nil, err
		}
		return n, nil
	}

	// Need interactive login.
	log.Println("tailscale-web: no persisted auth, starting OAuth flow...")
	backend.StartLoginInteractive(ctx)

	authURLTimeout := time.NewTimer(60 * time.Second)
	defer authURLTimeout.Stop()
	authStateTicker := time.NewTicker(500 * time.Millisecond)
	defer authStateTicker.Stop()
waitForPrompt:
	for {
		select {
		case <-ctx.Done():
			backend.Shutdown()
			return nil, ctx.Err()
		case <-loginURLCh:
			log.Println("tailscale-web: auth URL dispatched")
			break waitForPrompt
		case <-authStateTicker.C:
			// Some control servers authenticate without a browser prompt.
			if backendHasIdentity(backend.Status().BackendState, !backend.NodeKey().IsZero()) {
				break waitForPrompt
			}
		case <-authURLTimeout.C:
			backend.Shutdown()
			return nil, fmt.Errorf("timeout waiting for auth URL")
		}
	}

	if err := waitForAuth(ctx, backend, onAuthComplete); err != nil {
		backend.Shutdown()
		return nil, err
	}

	return n, nil
}

// resolveStore returns the state store to use: explicit > localStorage > in-memory.
func resolveStore(cfg Config, logf logger.Logf) ipn.StateStore {
	if cfg.Store != nil {
		return cfg.Store
	}
	if isLocalStorageAvailable() {
		prefix := cfg.StoragePrefix
		if prefix == "" {
			prefix = "tailscale-web"
		}
		return newLocalStorageStore(prefix, logf)
	}
	logf("tailscale-web: localStorage not available, using in-memory store (state will not persist)")
	return newMemStore()
}

// newNetstack creates, configures, and starts the gVisor-based network stack.
func newNetstack(logf logger.Logf, sys *tsd.System, eng wgengine.Engine, dialer *tsdial.Dialer) (*netstack.Impl, error) {
	stack, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		return nil, fmt.Errorf("failed to create netstack: %w", err)
	}
	sys.Set(stack)
	stack.ProcessLocalIPs = true
	stack.ProcessSubnets = true

	dialer.UseNetstackForIP = func(ip netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		conn, err := stack.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		conn, err := stack.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()
	return stack, nil
}

// notifyCallback returns the backend notification handler.
func notifyCallback(onAuthRequired OnAuthRequired, loginURLCh chan<- string) func(ipn.Notify) {
	return func(notif ipn.Notify) {
		if notif.State != nil {
			log.Printf("tailscale-web: state=%s", *notif.State)
		}
		if notif.ErrMessage != nil {
			log.Printf("tailscale-web: notice: %s", *notif.ErrMessage)
		}
		if notif.BrowseToURL == nil || *notif.BrowseToURL == "" {
			return
		}
		url := *notif.BrowseToURL
		log.Printf("tailscale-web: auth URL ready")
		if onAuthRequired != nil {
			onAuthRequired(url)
		}
		select {
		case loginURLCh <- url:
		default:
		}
	}
}

// buildPrefs constructs the initial Tailscale preferences from cfg.
func buildPrefs(cfg Config) *ipn.Prefs {
	prefs := ipn.NewPrefs()
	prefs.WantRunning = true
	prefs.Hostname = cfg.Hostname
	prefs.ControlURL = ipn.DefaultControlURL
	if cfg.ControlURL != "" {
		prefs.ControlURL = cfg.ControlURL
	}
	return prefs
}

// checkPersistedState polls the backend briefly to see if it has recovered
// from persisted state (already authenticated). Returns true if ready.
func checkPersistedState(backend *ipnlocal.LocalBackend, onAuthComplete OnAuthComplete) bool {
	time.Sleep(500 * time.Millisecond)
	for start := time.Now(); time.Since(start) < 5*time.Second; {
		st := backend.Status()
		if backendReady(st.BackendState, len(st.TailscaleIPs), !backend.NodeKey().IsZero()) {
			log.Printf("tailscale-web: restored from persisted state, IPs=%v", st.TailscaleIPs)
			if onAuthComplete != nil {
				onAuthComplete()
			}
			return true
		}
		if st.BackendState == "NeedsLogin" {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func waitForAuth(ctx context.Context, backend *ipnlocal.LocalBackend, onAuthComplete OnAuthComplete) error {
	log.Println("tailscale-web: waiting for authentication and a ready tunnel...")
	timeout := time.After(300 * time.Second)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout:
			state := backend.Status().BackendState
			if state == "Starting" || state == "Running" {
				return fmt.Errorf("authenticated, but the Tailscale tunnel did not become ready (state: %s); check access to Tailscale relays and reconnect", state)
			}
			return fmt.Errorf("timeout waiting for Tailscale authentication (state: %s); complete sign-in and device approval, or renew an expired login, then reconnect", state)
		case <-ticker.C:
			st := backend.Status()
			if backendReady(st.BackendState, len(st.TailscaleIPs), !backend.NodeKey().IsZero()) {
				log.Printf("tailscale-web: authenticated, IPs=%v", st.TailscaleIPs)
				if onAuthComplete != nil {
					onAuthComplete()
				}
				return nil
			}
		}
	}
}

// Running requires a live peer connection or a live DERP connection in the
// backend state machine. An assigned IP and node key alone are not readiness.
func backendReady(state string, ipCount int, hasNodeKey bool) bool {
	return state == "Running" && ipCount > 0 && hasNodeKey
}

func backendHasIdentity(state string, hasNodeKey bool) bool {
	return hasNodeKey && (state == "Starting" || state == "Running" || state == "NeedsMachineAuth")
}

// Dial opens a TCP connection through the Tailscale network.
func (n *Network) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return n.dialer.UserDial(ctx, network, addr)
}

// Listen opens a TCP listener on the Tailscale network for inbound connections
// from peers. Pass port 0 to have an ephemeral port assigned automatically.
func (n *Network) Listen(port int) (net.Listener, error) {
	return n.listeners.Listen(port)
}

// Ping sends an ICMP echo request to addr and measures round-trip time.
// addr may be a Tailscale IP address, a MagicDNS hostname (full or short), or
// a machine hostname. Any port suffix is stripped and ignored.
func (n *Network) Ping(ctx context.Context, addr string) (*PingResult, error) {
	// Strip port if present (ICMP doesn't use ports).
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}

	// Try to parse as IP directly first.
	ip, err := netip.ParseAddr(host)
	if err != nil {
		// Not an IP – resolve by searching the Tailscale peer list.
		// We avoid net.DefaultResolver because raw DNS sockets are unavailable
		// in the browser WASM sandbox.
		ip, err = n.resolvePeerAddr(host)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve %q: %w", host, err)
		}
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	res, err := n.backend.Ping(pingCtx, ip, tailcfg.PingICMP, 0)
	if err != nil {
		return &PingResult{Alive: false, Err: err.Error()}, nil
	}
	if res.Err != "" {
		return &PingResult{Alive: false, Err: res.Err}, nil
	}
	return &PingResult{
		Alive:          true,
		RttMs:          res.LatencySeconds * 1000,
		NodeName:       res.NodeName,
		NodeIP:         res.NodeIP,
		Endpoint:       res.Endpoint,
		DERPRegionCode: res.DERPRegionCode,
	}, nil
}

// resolvePeerAddr resolves a hostname to a Tailscale IPv4 address by searching
// the current peer list. It matches against:
//   - the peer's machine hostname (HostName)
//   - the full MagicDNS FQDN (DNSName, with or without trailing dot)
//   - the first label of the MagicDNS name (short name, e.g. "myhost")
func (n *Network) resolvePeerAddr(hostname string) (netip.Addr, error) {
	hostname = strings.ToLower(strings.TrimSuffix(hostname, "."))
	for _, peer := range n.backend.Status().Peer {
		dnsName := strings.ToLower(strings.TrimSuffix(peer.DNSName, "."))
		shortName := strings.SplitN(dnsName, ".", 2)[0]
		if strings.ToLower(peer.HostName) == hostname ||
			dnsName == hostname ||
			shortName == hostname {
			for _, ip := range peer.TailscaleIPs {
				if ip.Is4() {
					return ip, nil
				}
			}
		}
	}
	return netip.Addr{}, fmt.Errorf("no peer found for %q", hostname)
}

// Fetch makes an HTTP request through the Tailscale network.
func (n *Network) Fetch(ctx context.Context, rawURL string, opts FetchOptions) (*FetchResponse, error) {
	method := opts.Method
	if method == "" {
		method = "GET"
	}
	var body io.Reader
	if len(opts.BodyBytes) > 0 {
		body = bytes.NewReader(opts.BodyBytes)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	for k, v := range opts.Headers {
		req.Header.Set(k, v)
	}
	client, mode, err := n.downloadClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, explainDownloadError(err, mode, n.hasSelectedExitNode(), n.backend.NetMap())
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}
	headers := make(map[string]string, len(resp.Header))
	for k, vs := range resp.Header {
		if len(vs) > 0 {
			headers[k] = vs[0]
		}
	}
	return &FetchResponse{
		Status:     resp.StatusCode,
		StatusText: resp.Status,
		Headers:    headers,
		Body:       respBody,
	}, nil
}

// Close shuts down the Tailscale node.
func (n *Network) Close() error {
	n.downloadMu.Lock()
	n.closeDownloadIdleLocked()
	n.downloadMu.Unlock()
	if n.backend != nil {
		n.backend.Shutdown()
	}
	return nil
}

// GetLocalIPv4 returns the node's Tailscale IPv4 address, or empty string if unavailable.
func (n *Network) GetLocalIPv4() string {
	for _, ip := range n.backend.Status().TailscaleIPs {
		if ip.Is4() {
			return ip.String()
		}
	}
	return ""
}

// GetLocalIPv6 returns the node's Tailscale IPv6 address, or empty string if unavailable.
func (n *Network) GetLocalIPv6() string {
	for _, ip := range n.backend.Status().TailscaleIPs {
		if ip.Is6() {
			return ip.String()
		}
	}
	return ""
}

// GetPrefs returns the current relevant preferences.
func (n *Network) GetPrefs() Prefs {
	p := n.backend.Prefs()
	n.downloadMu.Lock()
	mode := n.dnsMode
	n.downloadMu.Unlock()
	if mode == "" || p.ExitNodeID() == "" {
		mode = DNSModeExitNode
	}
	return Prefs{
		AcceptRoutes: p.RouteAll(),
		ExitNodeID:   string(p.ExitNodeID()),
		DNSMode:      mode,
	}
}

// SetAcceptRoutes enables or disables acceptance of subnet routes advertised
// by peers. This is equivalent to `tailscale set --accept-routes`.
func (n *Network) SetAcceptRoutes(accept bool) error {
	_, err := n.backend.EditPrefs(&ipn.MaskedPrefs{
		Prefs:       ipn.Prefs{RouteAll: accept},
		RouteAllSet: true,
	})
	return err
}

// ListExitNodes returns all peers that advertise exit-node capability.
func (n *Network) ListExitNodes() []*ExitNode {
	status := n.backend.Status()
	var nodes []*ExitNode
	for _, peer := range status.Peer {
		if !peer.ExitNodeOption {
			continue
		}
		node := &ExitNode{
			ID:       string(peer.ID),
			HostName: peer.HostName,
			DNSName:  peer.DNSName,
			Active:   peer.ExitNode,
			Online:   peer.Online,
			OS:       peer.OS,
			Expired:  peer.Expired,
		}
		if len(peer.TailscaleIPs) > 0 {
			node.TailscaleIP = peer.TailscaleIPs[0].String()
		}
		nodes = append(nodes, node)
	}
	return nodes
}

// Route represents a single entry in the routing table.
type Route struct {
	// Prefix is the CIDR being routed (e.g. "10.0.0.0/24" or "0.0.0.0/0").
	Prefix string
	// Via is the display name of the node advertising this route,
	// or "self" for routes owned by this node.
	Via string
	// IsPrimary reports whether this node is the primary (active) router
	// for the prefix. For self-routes this is always true.
	IsPrimary bool
	// IsExitRoute reports whether this is a default/exit route (0.0.0.0/0 or ::/0).
	IsExitRoute bool
}

// DNSInfo holds the Tailscale-managed DNS configuration.
type DNSInfo struct {
	// Resolvers are the global nameservers.
	Resolvers []string
	// Routes maps DNS search suffixes to their dedicated resolvers.
	// A nil/empty resolver list means "use the built-in MagicDNS resolver".
	Routes map[string][]string
	// Domains are the search/split-DNS domains.
	Domains []string
	// ExtraRecords are custom DNS records pushed by the control plane.
	ExtraRecords []DNSRecord
	// MagicDNS reports whether MagicDNS (proxied resolution) is enabled.
	MagicDNS bool
}

// DNSRecord is a single custom DNS record.
type DNSRecord struct {
	Name  string
	Type  string
	Value string
}

// GetRoutes returns the full routing table derived from the current network map.
func (n *Network) GetRoutes() []*Route {
	nm := n.backend.NetMap()
	if nm == nil {
		return nil
	}

	isExit := func(p string) bool { return p == "0.0.0.0/0" || p == "::/0" }

	var routes []*Route

	// Self-advertised routes.
	if nm.SelfNode.Valid() {
		for _, p := range nm.SelfNode.AllowedIPs().All() {
			routes = append(routes, &Route{
				Prefix:      p.String(),
				Via:         "self",
				IsPrimary:   true,
				IsExitRoute: isExit(p.String()),
			})
		}
	}

	// Peer routes.
	for _, peer := range nm.Peers {
		name := peer.Name()
		if name == "" {
			name = peer.Hostinfo().Hostname()
		}
		primary := make(map[string]bool)
		for _, p := range peer.PrimaryRoutes().All() {
			primary[p.String()] = true
		}
		for _, p := range peer.AllowedIPs().All() {
			ps := p.String()
			routes = append(routes, &Route{
				Prefix:      ps,
				Via:         name,
				IsPrimary:   primary[ps],
				IsExitRoute: isExit(ps),
			})
		}
	}

	sort.Slice(routes, func(i, j int) bool {
		return routes[i].Prefix < routes[j].Prefix
	})
	return routes
}

// GetDNS returns the Tailscale-managed DNS configuration.
func (n *Network) GetDNS() DNSInfo {
	nm := n.backend.NetMap()
	if nm == nil {
		return DNSInfo{}
	}
	cfg := nm.DNS

	info := DNSInfo{
		MagicDNS: cfg.Proxied,
		Domains:  cfg.Domains,
	}

	for _, r := range cfg.Resolvers {
		info.Resolvers = append(info.Resolvers, r.Addr)
	}

	if len(cfg.Routes) > 0 {
		info.Routes = make(map[string][]string, len(cfg.Routes))
		for suffix, resolvers := range cfg.Routes {
			addrs := make([]string, 0, len(resolvers))
			for _, r := range resolvers {
				addrs = append(addrs, r.Addr)
			}
			info.Routes[suffix] = addrs
		}
	}

	for _, rec := range cfg.ExtraRecords {
		t := rec.Type
		if t == "" {
			t = "A"
		}
		info.ExtraRecords = append(info.ExtraRecords, DNSRecord{
			Name:  rec.Name,
			Type:  t,
			Value: rec.Value,
		})
	}

	return info
}

// SetExitNode activates the exit node with the given stable node ID.
// Pass an empty string to clear the exit node.
func (n *Network) SetExitNode(id string) error {
	if id != "" {
		if nm := n.backend.NetMap(); nm != nil {
			if peer, ok := nm.PeerWithStableID(tailcfg.StableNodeID(id)); ok && peer.Expired() {
				return fmt.Errorf("the selected exit node's device key has expired; reauthenticate that device in Tailscale before selecting it")
			}
		}
	}
	mp := &ipn.MaskedPrefs{
		Prefs:         ipn.Prefs{ExitNodeID: tailcfg.StableNodeID(id)},
		ExitNodeIDSet: true,
	}
	if id == "" {
		// Also clear any IP-based exit node setting.
		mp.ExitNodeIPSet = true
	}
	_, err := n.backend.EditPrefs(mp)
	if err != nil {
		return err
	}
	n.downloadMu.Lock()
	defer n.downloadMu.Unlock()
	n.closeDownloadIdleLocked()
	if id == "" {
		n.dnsMode = DNSModeExitNode
	}
	n.resetPublicDownloadClientLocked()
	return nil
}

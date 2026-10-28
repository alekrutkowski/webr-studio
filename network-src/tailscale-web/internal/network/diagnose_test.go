//go:build js

package network

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine"
)

func diagnosticTestDeps(t *testing.T) diagnosticDeps {
	t.Helper()
	online := true
	peer := (&tailcfg.Node{
		StableID: "exit-under-test", Key: key.NewNode().Public(), Name: "exit.example.ts.net.", Online: &online,
		Hostinfo:  (&tailcfg.Hostinfo{Hostname: "test-exit", OS: "linux"}).View(),
		Addresses: []netip.Prefix{netip.MustParsePrefix("100.64.0.2/32")},
	}).View()
	snapshot := diagnosticSnapshot{exitID: peer.StableID(), peer: peer, localKey: key.NewNode().Public()}
	return diagnosticDeps{
		snapshot: func() (diagnosticSnapshot, error) { return snapshot, nil },
		peerForIP: func(ip netip.Addr) (wgengine.PeerForIP, bool) {
			if ip != diagnosticIP {
				t.Errorf("route lookup used %s", ip)
			}
			return wgengine.PeerForIP{Node: peer, Route: netip.MustParsePrefix("0.0.0.0/0")}, true
		},
		ping: func(ctx context.Context, ip netip.Addr, kind tailcfg.PingType, size int) (*ipnstate.PingResult, error) {
			if ip != netip.MustParseAddr("100.64.0.2") || (kind != tailcfg.PingTSMP && kind != tailcfg.PingPeerAPI) || size != 0 {
				t.Errorf("unexpected peer probe: %s %s %d", ip, kind, size)
			}
			return &ipnstate.PingResult{PeerAPIPort: 1}, nil
		},
		dial: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("fixture TCP connection refused")
		},
		stageTimeout: 2 * time.Second,
		totalTimeout: 5 * time.Second,
	}
}

// The fixture runs real verified TLS and HTTP/1.1 over one in-memory TCP
// connection. It deliberately never sends a response body, proving that the
// diagnostic finishes after headers and does not collect trace/IP data.
func diagnosticTLSFixture(t *testing.T, deps *diagnosticDeps, mode string) *atomic.Int32 {
	t.Helper()
	f := newDNSFixture(t) // reuse only its generated certificate and trust pool
	deps.roots = f.roots
	if mode == "untrusted" {
		deps.roots = x509.NewCertPool()
	}
	calls := new(atomic.Int32)
	deps.dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		calls.Add(1)
		if network != "tcp" || address != "1.1.1.1:443" {
			t.Errorf("diagnostic dial was not DNS-free: %s %s", network, address)
		}
		client, server := net.Pipe()
		t.Cleanup(func() { client.Close(); server.Close() })
		if mode == "tls-timeout" {
			return client, nil
		}
		go func() {
			defer server.Close()
			server.SetDeadline(time.Now().Add(4 * time.Second))
			secure := tls.Server(server, &tls.Config{Certificates: []tls.Certificate{f.cert}, NextProtos: []string{"http/1.1"}})
			request, err := http.ReadRequest(bufio.NewReader(secure))
			if mode == "untrusted" {
				if err == nil {
					t.Error("untrusted certificate unexpectedly reached HTTP")
				}
				return
			}
			if err != nil {
				t.Error(err)
				return
			}
			defer request.Body.Close()
			if request.Method != "GET" || request.URL.Path != "/cdn-cgi/trace" || request.Host != "1.1.1.1" || request.Proto != "HTTP/1.1" {
				t.Errorf("unexpected diagnostic HTTP request: %s %s %s %s", request.Method, request.URL, request.Host, request.Proto)
			}
			if request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
				t.Error("diagnostic sent credentials")
			}
			if secure.ConnectionState().NegotiatedProtocol != "http/1.1" {
				t.Error("diagnostic negotiated a protocol other than HTTP/1.1")
			}
			if mode == "http-timeout" {
				io.Copy(io.Discard, secure)
				return
			}
			status := "200 OK"
			if mode == "http-error" {
				status = "403 Forbidden"
			}
			// A nonzero promised body is never sent. Reading/draining it would
			// hang until the stage timeout and fail the successful-header test.
			_, err = io.WriteString(secure, "HTTP/1.1 "+status+"\r\nContent-Type: text/plain\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n")
			if err != nil {
				t.Error(err)
				return
			}
			io.Copy(io.Discard, secure)
		}()
		return client, nil
	}
	return calls
}

func checkDiagnosticStatus(t *testing.T, result DiagnosticResult, id, status string) DiagnosticCheck {
	t.Helper()
	for _, check := range result.Checks {
		if check.ID == id {
			if check.Status != status {
				t.Fatalf("%s = %s (%s), want %s", id, check.Status, check.Message, status)
			}
			return check
		}
	}
	t.Fatalf("missing diagnostic stage %s", id)
	return DiagnosticCheck{}
}

func TestDiagnoseVerifiedTLSSameConnectionHeadersOnly(t *testing.T) {
	deps := diagnosticTestDeps(t)
	calls := diagnosticTLSFixture(t, &deps, "success")
	result := runDiagnostics(context.Background(), deps)
	if result.ExitNodeID != "exit-under-test" || result.ExitNodeName != "test-exit" || result.ExitNodeIP != "100.64.0.2" || result.ExitNodeOS != "linux" || !result.ExitNodeOnline || result.ExitNodeExpired {
		t.Fatalf("unexpected exit metadata: %+v", result)
	}
	wantIDs := []string{"exit", "route", "peer", "peerapi", "tcp", "tls", "http"}
	if len(result.Checks) != len(wantIDs) {
		t.Fatalf("unexpected check count: %d", len(result.Checks))
	}
	for i, id := range wantIDs {
		if result.Checks[i].ID != id {
			t.Fatalf("stages are out of order: %+v", result.Checks)
		}
		checkDiagnosticStatus(t, result, id, "pass")
	}
	if calls.Load() != 1 {
		t.Fatalf("TCP/TLS/HTTP used %d connections, want one", calls.Load())
	}
	if !strings.Contains(result.Checks[2].Message, "port 1") {
		t.Error("live TSMP PeerAPI port was lost")
	}
	if !strings.Contains(result.Checks[6].Message, "HTTP 200") {
		t.Error("HTTP status was lost")
	}
}

func TestDiagnosePreconditionsAndRouteOwnership(t *testing.T) {
	for _, scenario := range []string{"unselected", "expired", "missing-route", "other-peer", "specific-route"} {
		t.Run(scenario, func(t *testing.T) {
			deps := diagnosticTestDeps(t)
			snapshot, _ := deps.snapshot()
			switch scenario {
			case "unselected":
				snapshot.exitID = ""
			case "expired":
				node := snapshot.peer.AsStruct()
				node.Expired = true
				snapshot.peer = node.View()
			}
			deps.snapshot = func() (diagnosticSnapshot, error) { return snapshot, nil }
			deps.peerForIP = func(netip.Addr) (wgengine.PeerForIP, bool) {
				match := wgengine.PeerForIP{Node: snapshot.peer, Route: netip.MustParsePrefix("0.0.0.0/0")}
				switch scenario {
				case "missing-route":
					return match, false
				case "other-peer":
					node := match.Node.AsStruct()
					node.StableID = "different-exit"
					match.Node = node.View()
				case "specific-route":
					match.Route = netip.MustParsePrefix("1.1.1.0/24")
				}
				return match, true
			}
			var dialed atomic.Bool
			deps.dial = func(context.Context, string, string) (net.Conn, error) {
				dialed.Store(true)
				return nil, errors.New("must not dial")
			}
			result := runDiagnostics(context.Background(), deps)
			if scenario == "unselected" || scenario == "expired" {
				checkDiagnosticStatus(t, result, "exit", "fail")
				checkDiagnosticStatus(t, result, "peer", "skip")
				checkDiagnosticStatus(t, result, "route", "skip")
			} else {
				checkDiagnosticStatus(t, result, "exit", "pass")
				checkDiagnosticStatus(t, result, "route", "fail")
				checkDiagnosticStatus(t, result, "peer", "pass")
			}
			checkDiagnosticStatus(t, result, "tcp", "skip")
			if dialed.Load() {
				t.Fatal("public TCP dial occurred without a valid selected exit/default route")
			}
		})
	}
}

func TestDiagnoseTLSAndHTTPFailuresStayAtTheirStage(t *testing.T) {
	for _, mode := range []string{"untrusted", "http-error"} {
		t.Run(mode, func(t *testing.T) {
			deps := diagnosticTestDeps(t)
			calls := diagnosticTLSFixture(t, &deps, mode)
			result := runDiagnostics(context.Background(), deps)
			checkDiagnosticStatus(t, result, "tcp", "pass")
			if mode == "untrusted" {
				checkDiagnosticStatus(t, result, "tls", "fail")
				checkDiagnosticStatus(t, result, "http", "skip")
			} else {
				checkDiagnosticStatus(t, result, "tls", "pass")
				if check := checkDiagnosticStatus(t, result, "http", "fail"); !strings.Contains(check.Message, "HTTP 403") {
					t.Errorf("lost HTTP error: %s", check.Message)
				}
			}
			if calls.Load() != 1 {
				t.Error("failure retried through another connection or transport")
			}
		})
	}
}

func TestDiagnoseNetworkStagesHaveDeadlines(t *testing.T) {
	for _, mode := range []string{"peer", "tcp", "tls-timeout", "http-timeout"} {
		t.Run(mode, func(t *testing.T) {
			deps := diagnosticTestDeps(t)
			deps.stageTimeout = 100 * time.Millisecond
			switch mode {
			case "peer":
				deps.ping = func(ctx context.Context, _ netip.Addr, _ tailcfg.PingType, _ int) (*ipnstate.PingResult, error) {
					<-ctx.Done()
					return nil, ctx.Err()
				}
			case "tcp":
				deps.dial = func(ctx context.Context, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
			default:
				diagnosticTLSFixture(t, &deps, mode)
			}
			start := time.Now()
			result := runDiagnostics(context.Background(), deps)
			id := strings.TrimSuffix(mode, "-timeout")
			checkDiagnosticStatus(t, result, id, "fail")
			if mode == "peer" {
				checkDiagnosticStatus(t, result, "peerapi", "fail")
			}
			if mode == "tcp" {
				checkDiagnosticStatus(t, result, "tls", "skip")
			}
			if mode == "tls-timeout" {
				checkDiagnosticStatus(t, result, "http", "skip")
			}
			if time.Since(start) > time.Second {
				t.Fatal("a network stage exceeded its bounded test deadline")
			}
		})
	}
}

func TestDiagnoseCancellationAndChangedExit(t *testing.T) {
	t.Run("canceled", func(t *testing.T) {
		deps := diagnosticTestDeps(t)
		deps.ping = func(ctx context.Context, _ netip.Addr, _ tailcfg.PingType, _ int) (*ipnstate.PingResult, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		deps.dial = func(ctx context.Context, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
		ctx, cancel := context.WithCancel(context.Background())
		timer := time.AfterFunc(20*time.Millisecond, cancel)
		defer timer.Stop()
		defer cancel()
		start := time.Now()
		result := runDiagnostics(ctx, deps)
		for _, id := range []string{"peer", "peerapi", "tcp"} {
			if check := checkDiagnosticStatus(t, result, id, "fail"); !strings.Contains(check.Message, "canceled") {
				t.Errorf("%s did not report cancellation: %s", id, check.Message)
			}
		}
		if time.Since(start) > time.Second {
			t.Fatal("cancellation did not stop the independent network probes")
		}
	})
	t.Run("exit changed", func(t *testing.T) {
		deps := diagnosticTestDeps(t)
		initial, _ := deps.snapshot()
		var state atomic.Pointer[diagnosticSnapshot]
		state.Store(&initial)
		deps.snapshot = func() (diagnosticSnapshot, error) { return *state.Load(), nil }
		deps.dial = func(context.Context, string, string) (net.Conn, error) {
			changed := initial
			changed.exitID = "new-exit"
			state.Store(&changed)
			return nil, errors.New("old connection closed")
		}
		result := runDiagnostics(context.Background(), deps)
		if check := checkDiagnosticStatus(t, result, "tcp", "fail"); !strings.Contains(check.Message, "changed") {
			t.Errorf("stale connection was not identified: %s", check.Message)
		}
		checkDiagnosticStatus(t, result, "exit", "fail")
	})
}

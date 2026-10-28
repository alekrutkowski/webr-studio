//go:build js

package network

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine"
)

const (
	diagnosticStageTimeout = 10 * time.Second
	diagnosticTotalTimeout = 35 * time.Second
	diagnosticAddress      = "1.1.1.1:443"
	diagnosticURL          = "https://1.1.1.1/cdn-cgi/trace"
)

var diagnosticIP = netip.MustParseAddr("1.1.1.1")

// DiagnosticCheck records one explicit network probe. Messages contain no
// response bodies, credentials, keys, or exported runtime logs.
type DiagnosticCheck struct {
	ID        string
	Label     string
	Status    string
	ElapsedMs float64
	Message   string
}

// DiagnosticResult separates peer reachability from the route, TCP, TLS, and
// HTTP path to one specific public address. Failure does not establish that
// every public destination is unavailable.
type DiagnosticResult struct {
	ExitNodeID      string
	ExitNodeName    string
	ExitNodeIP      string
	ExitNodeOS      string
	ExitNodeOnline  bool
	ExitNodeExpired bool
	Checks          []DiagnosticCheck
}

type diagnosticSnapshot struct {
	exitID   tailcfg.StableNodeID
	peer     tailcfg.NodeView
	localKey key.NodePublic
}

// These dependencies keep the probe logic testable with real HTTP/TLS over
// in-memory connections. Production always supplies the existing Tailscale
// engine, backend, and userspace dialer; no browser or system dialer is used.
type diagnosticDeps struct {
	snapshot     func() (diagnosticSnapshot, error)
	peerForIP    func(netip.Addr) (wgengine.PeerForIP, bool)
	ping         func(context.Context, netip.Addr, tailcfg.PingType, int) (*ipnstate.PingResult, error)
	dial         func(context.Context, string, string) (net.Conn, error)
	roots        *x509.CertPool // nil in production: normal embedded public roots
	stageTimeout time.Duration
	totalTimeout time.Duration
}

// Diagnose runs only when explicitly requested. It does not change DNS mode,
// routes, exit selection, certificate verification, or download timeouts.
func (n *Network) Diagnose(ctx context.Context) DiagnosticResult {
	return runDiagnostics(ctx, diagnosticDeps{
		snapshot: func() (diagnosticSnapshot, error) {
			s := diagnosticSnapshot{exitID: n.backend.Prefs().ExitNodeID()}
			nm := n.backend.NetMap()
			if nm == nil {
				return s, errors.New("the Tailscale network map is not ready; reconnect and run the diagnostic again")
			}
			s.localKey = nm.NodeKey
			s.peer, _ = nm.PeerWithStableID(s.exitID)
			return s, nil
		},
		peerForIP: func(ip netip.Addr) (wgengine.PeerForIP, bool) {
			if n.engine == nil {
				return wgengine.PeerForIP{}, false
			}
			return n.engine.PeerForIP(ip)
		},
		ping: n.backend.Ping,
		dial: n.dialer.UserDial,
	})
}

func runDiagnostics(parent context.Context, deps diagnosticDeps) DiagnosticResult {
	result := DiagnosticResult{Checks: []DiagnosticCheck{
		{ID: "exit", Label: "Selected exit node", Status: "skip", Message: "Not run."},
		{ID: "route", Label: "Route to 1.1.1.1", Status: "skip", Message: "A valid exit node is required."},
		{ID: "peer", Label: "Encrypted exit connection", Status: "skip", Message: "A valid exit node is required."},
		{ID: "peerapi", Label: "Exit PeerAPI", Status: "skip", Message: "A valid exit node is required."},
		{ID: "tcp", Label: "TCP to 1.1.1.1:443", Status: "skip", Message: "A matching configured exit route is required."},
		{ID: "tls", Label: "TLS to 1.1.1.1", Status: "skip", Message: "TCP must connect first."},
		{ID: "http", Label: "HTTPS response from 1.1.1.1", Status: "skip", Message: "Verified TLS must complete first."},
	}}
	stageTimeout := deps.stageTimeout
	if stageTimeout <= 0 || stageTimeout > diagnosticStageTimeout {
		stageTimeout = diagnosticStageTimeout
	}
	totalTimeout := deps.totalTimeout
	if totalTimeout <= 0 || totalTimeout > diagnosticTotalTimeout {
		totalTimeout = diagnosticTotalTimeout
	}
	deadlineCtx, stopDeadline := context.WithTimeout(parent, totalTimeout)
	defer stopDeadline()
	ctx, cancel := context.WithCancelCause(deadlineCtx)
	defer cancel(nil)

	started := time.Now()
	snapshot, snapshotErr := deps.snapshot()
	result.ExitNodeID = string(snapshot.exitID)
	if snapshot.peer.Valid() {
		result.ExitNodeName = strings.TrimSuffix(snapshot.peer.Name(), ".")
		result.ExitNodeExpired = snapshot.peer.Expired()
		result.ExitNodeOnline = snapshot.peer.Online().GetOr(false)
		if hi := snapshot.peer.Hostinfo(); hi.Valid() {
			result.ExitNodeOS = hi.OS()
			if hi.Hostname() != "" {
				result.ExitNodeName = hi.Hostname()
			}
		}
		if ip := diagnosticPeerIP(snapshot.peer); ip.IsValid() {
			result.ExitNodeIP = ip.String()
		}
	}
	exitErr := snapshotErr
	if exitErr == nil {
		exitErr = validateDiagnosticExit(snapshot)
	}
	if exitErr == nil {
		exitErr = ctx.Err()
	}
	if exitErr != nil {
		setDiagnosticCheck(&result.Checks[0], started, "", exitErr)
		return result
	}
	exitMessage := "The selected exit is present and its device key has not expired."
	if !result.ExitNodeOnline {
		exitMessage += " The control server is not reporting it online; the probes below test actual reachability."
	}
	setDiagnosticCheck(&result.Checks[0], started, exitMessage, nil)
	exitIP := diagnosticPeerIP(snapshot.peer)

	currentRoute := func() error {
		peer, ok := deps.peerForIP(diagnosticIP)
		return validateDiagnosticRoute(snapshot.exitID, peer, ok)
	}
	consistent := func() error {
		current, err := deps.snapshot()
		if err != nil {
			return err
		}
		if current.exitID != snapshot.exitID || current.localKey != snapshot.localKey ||
			!current.peer.Valid() || current.peer.Key() != snapshot.peer.Key() || current.peer.Expired() {
			return errors.New("the Tailscale connection or selected exit changed; run the diagnostic again")
		}
		return nil
	}
	started = time.Now()
	routeErr := consistent()
	if routeErr == nil {
		routeErr = currentRoute()
	}
	setDiagnosticCheck(&result.Checks[1], started, "The WireGuard engine is configured to route 1.1.1.1 through 0.0.0.0/0 on the selected exit. The following probes test whether packets get through.", routeErr)

	// Cancel promptly if the peer identity, selected exit, or verified public
	// route changes while a probe is waiting. Never publish a clean result for
	// a connection different from the one described in the result metadata.
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				err := consistent()
				if err == nil && routeErr == nil {
					err = currentRoute()
				}
				if err != nil {
					cancel(err)
					return
				}
			}
		}
	}()
	defer func() { cancel(nil); <-monitorDone }()

	run := func(index int, needsRoute bool, probe func(context.Context) (string, error)) bool {
		start := time.Now()
		stageCtx, stop := context.WithTimeout(ctx, stageTimeout)
		defer stop()
		err := diagnosticContextError(stageCtx)
		if err == nil {
			err = consistent()
		}
		if err == nil && needsRoute {
			err = currentRoute()
		}
		var message string
		if err == nil {
			message, err = probe(stageCtx)
		}
		if contextErr := diagnosticContextError(stageCtx); contextErr != nil {
			err = contextErr
		} else if changed := consistent(); changed != nil {
			err = changed
		} else if needsRoute {
			if changed := currentRoute(); changed != nil {
				err = changed
			}
		}
		setDiagnosticCheck(&result.Checks[index], start, message, err)
		return err == nil
	}

	var probes sync.WaitGroup
	for _, spec := range []struct {
		index int
		kind  tailcfg.PingType
	}{{2, tailcfg.PingTSMP}, {3, tailcfg.PingPeerAPI}} {
		probes.Go(func() {
			run(spec.index, false, func(stageCtx context.Context) (string, error) {
				response, err := deps.ping(stageCtx, exitIP, spec.kind, 0)
				if err != nil {
					return "", err
				}
				if response == nil {
					return "", errors.New("the exit probe returned no result")
				}
				if response.Err != "" {
					return "", errors.New(response.Err)
				}
				if spec.kind == tailcfg.PingTSMP {
					message := "The exit replied through the encrypted WireGuard connection. This does not test internet access permissions."
					if response.PeerAPIPort != 0 {
						message += fmt.Sprintf(" Its reply reports PeerAPI port %d.", response.PeerAPIPort)
					}
					return message, nil
				}
				return "The exit PeerAPI answered a DNS-free HTTP HEAD request. This does not test public internet forwarding.", nil
			})
		})
	}
	if routeErr == nil {
		probes.Go(func() {
			var raw net.Conn
			defer func() {
				if raw != nil {
					raw.Close()
				}
			}()
			if !run(4, true, func(stageCtx context.Context) (string, error) {
				var err error
				raw, err = deps.dial(stageCtx, "tcp", diagnosticAddress)
				if err == nil && raw == nil {
					err = errors.New("the userspace dialer returned no connection")
				}
				return "TCP connected to 1.1.1.1:443 through the selected exit, without DNS.", err
			}) {
				return
			}
			stopClose := context.AfterFunc(ctx, func() { raw.Close() })
			defer stopClose()
			secure := tls.Client(raw, &tls.Config{
				ServerName: "1.1.1.1", RootCAs: deps.roots,
				MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"},
			})
			if !run(5, true, func(stageCtx context.Context) (string, error) {
				stop := context.AfterFunc(stageCtx, func() { raw.Close() })
				defer stop()
				if deadline, ok := stageCtx.Deadline(); ok {
					if err := raw.SetDeadline(deadline); err != nil {
						return "", err
					}
				}
				if err := secure.HandshakeContext(stageCtx); err != nil {
					return "", err
				}
				return "TLS completed on the same TCP connection and the certificate was verified for 1.1.1.1.", nil
			}) {
				return
			}
			run(6, true, func(stageCtx context.Context) (string, error) {
				stop := context.AfterFunc(stageCtx, func() { raw.Close() })
				defer stop()
				if deadline, ok := stageCtx.Deadline(); ok {
					if err := raw.SetDeadline(deadline); err != nil {
						return "", err
					}
				}
				request, err := http.NewRequestWithContext(stageCtx, http.MethodGet, diagnosticURL, nil)
				if err != nil {
					return "", err
				}
				request.Close = true
				if err := request.Write(secure); err != nil {
					return "", err
				}
				// Read only status and headers, with a strict bound on parser input.
				// No redirects are followed and the trace body is never read or saved.
				response, err := http.ReadResponse(bufio.NewReader(io.LimitReader(secure, 64<<10)), request)
				if err != nil {
					return "", err
				}
				raw.Close() // stop the body immediately; do not drain it on Close
				response.Body.Close()
				if response.StatusCode < 200 || response.StatusCode >= 400 {
					return "", fmt.Errorf("received HTTP %d from 1.1.1.1 on the verified TLS connection; the response body was not read", response.StatusCode)
				}
				return fmt.Sprintf("Received HTTP %d from 1.1.1.1 on the same verified TLS connection. No redirect was followed and the response body was not read.", response.StatusCode), nil
			})
		})
	}
	probes.Wait()
	if err := consistent(); err != nil {
		setDiagnosticCheck(&result.Checks[0], time.Now(), "", err)
	} else if routeErr == nil {
		if err := currentRoute(); err != nil {
			setDiagnosticCheck(&result.Checks[1], time.Now(), "", err)
		}
	}
	return result
}

func diagnosticPeerIP(peer tailcfg.NodeView) netip.Addr {
	if !peer.Valid() {
		return netip.Addr{}
	}
	var first netip.Addr
	for _, prefix := range peer.Addresses().All() {
		if !prefix.IsSingleIP() {
			continue
		}
		ip := prefix.Addr()
		if ip.Is4() {
			return ip
		}
		if !first.IsValid() {
			first = ip
		}
	}
	return first
}

func validateDiagnosticExit(snapshot diagnosticSnapshot) error {
	if snapshot.exitID == "" {
		return errors.New("select an exit node before running the diagnostic")
	}
	if !snapshot.peer.Valid() || snapshot.peer.StableID() != snapshot.exitID {
		return errors.New("the selected exit is absent from the current network map; refresh or reconnect")
	}
	if snapshot.peer.Expired() {
		return errors.New("the selected exit node's device key has expired; reauthenticate that device in Tailscale")
	}
	if !diagnosticPeerIP(snapshot.peer).IsValid() {
		return errors.New("the selected exit has no Tailscale IP address")
	}
	return nil
}

func validateDiagnosticRoute(exitID tailcfg.StableNodeID, match wgengine.PeerForIP, ok bool) error {
	if !ok || !match.Node.Valid() {
		return errors.New("the WireGuard engine has no configured route to 1.1.1.1")
	}
	if match.IsSelf || match.Node.StableID() != exitID {
		return fmt.Errorf("the configured route to 1.1.1.1 (%s) does not use the selected exit", match.Route)
	}
	if match.Route != netip.MustParsePrefix("0.0.0.0/0") {
		return fmt.Errorf("1.1.1.1 uses a more specific configured route (%s), so this probe would not test the selected default exit route", match.Route)
	}
	return nil
}

func diagnosticContextError(ctx context.Context) error {
	if ctx.Err() == nil {
		return nil
	}
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return ctx.Err()
}

func setDiagnosticCheck(check *DiagnosticCheck, started time.Time, message string, err error) {
	check.ElapsedMs = float64(time.Since(started)) / float64(time.Millisecond)
	check.Status, check.Message = "pass", message
	if err != nil {
		check.Status = "fail"
		if errors.Is(err, context.DeadlineExceeded) {
			check.Message = "This stage timed out before it completed."
		} else if errors.Is(err, context.Canceled) {
			check.Message = "The diagnostic was canceled."
		} else {
			check.Message = err.Error()
		}
	}
	check.Message = strings.ReplaceAll(strings.ReplaceAll(check.Message, "\r", " "), "\n", " ")
	if len(check.Message) > 512 {
		check.Message = check.Message[:512] + "…"
	}
}

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"charm.land/log/v2"
	"charm.land/wish/v2"
	"charm.land/wish/v2/accesscontrol"
	"charm.land/wish/v2/activeterm"
	"charm.land/wish/v2/logging"
	"github.com/charmbracelet/ssh"
)

func main() {
	host := envString("SSH_HOST", "0.0.0.0")
	port := envString("SSH_PORT", "23234")
	hostKeyPath := envString("SSH_HOST_KEY_PATH", ".ssh/gpu-ssh-monitor_ed25519")
	dashboard := newDashboardDaemon()

	server, err := wish.NewServer(
		wish.WithAddress(net.JoinHostPort(host, port)),
		wish.WithHostKeyPath(hostKeyPath),
		wish.WithMiddleware(
			dashboardMiddleware(dashboard),
			activeterm.Middleware(),
			accesscontrol.Middleware(),
			logging.Middleware(),
		),
	)
	if err != nil {
		log.Fatal("Could not create SSH server", "error", err)
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	log.Info("Starting SSH monitor", "host", host, "port", port)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
			log.Error("Could not start SSH server", "error", err)
			done <- nil
		}
	}()

	<-done
	log.Info("Stopping SSH monitor")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
		log.Error("Could not stop SSH server", "error", err)
	}
	dashboard.stop()
}

type dashboardDaemon struct {
	mu          sync.Mutex
	workdir     string
	scriptPath  string
	command     string
	socketPath  string
	cmd         *exec.Cmd
	done        chan error
	lastStartAt time.Time
	active      int
}

func newDashboardDaemon() *dashboardDaemon {
	workdir := envString("DASHBOARD_WORKDIR", mustGetwd())
	return &dashboardDaemon{
		workdir:    workdir,
		scriptPath: envString("DASHBOARD_SCRIPT", filepath.Join(workdir, "ssh-dashboard.cjs")),
		command:    envString("DASHBOARD_CMD", envString("NODE_CMD", "node")),
		socketPath: envString("SSH_DASHBOARD_SOCKET", filepath.Join(os.TempDir(), "gpu-ssh-monitor.sock")),
	}
}

func (d *dashboardDaemon) ensureStarted() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.isRunning() && d.socketReady(100*time.Millisecond) {
		return nil
	}
	if d.cmd != nil {
		d.stopLocked()
	}

	if since := time.Since(d.lastStartAt); since > 0 && since < time.Second {
		time.Sleep(time.Second - since)
	}
	d.lastStartAt = time.Now()

	_ = os.Remove(d.socketPath)
	cmd := exec.Command(d.command, d.scriptPath, "--server")
	cmd.Dir = d.workdir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"SSH_DASHBOARD_SOCKET="+d.socketPath,
	)

	if err := cmd.Start(); err != nil {
		return err
	}

	d.cmd = cmd
	d.done = make(chan error, 1)
	go func() {
		d.done <- cmd.Wait()
	}()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.socketReady(100 * time.Millisecond) {
			return nil
		}
		select {
		case err := <-d.done:
			d.cmd = nil
			d.done = nil
			return fmt.Errorf("dashboard exited before socket was ready: %w", err)
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}

	d.stopLocked()
	return fmt.Errorf("dashboard socket did not become ready: %s", d.socketPath)
}

func (d *dashboardDaemon) isRunning() bool {
	if d.cmd == nil || d.cmd.Process == nil {
		return false
	}
	select {
	case <-d.done:
		d.cmd = nil
		d.done = nil
		return false
	default:
		return true
	}
}

func (d *dashboardDaemon) socketReady(timeout time.Duration) bool {
	conn, err := net.DialTimeout("unix", d.socketPath, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (d *dashboardDaemon) dial() (net.Conn, error) {
	d.clientConnected()
	if err := d.ensureStarted(); err != nil {
		d.clientDisconnected()
		return nil, err
	}
	conn, err := net.DialTimeout("unix", d.socketPath, 2*time.Second)
	if err != nil {
		d.clientDisconnected()
		return nil, err
	}
	return conn, nil
}

func (d *dashboardDaemon) clientConnected() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.active++
}

func (d *dashboardDaemon) clientDisconnected() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.active > 0 {
		d.active--
	}
	if d.active == 0 {
		d.stopLocked()
	}
}

func (d *dashboardDaemon) stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stopLocked()
}

func (d *dashboardDaemon) stopLocked() {
	if d.cmd == nil || d.cmd.Process == nil {
		_ = os.Remove(d.socketPath)
		return
	}

	_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-d.done:
	case <-time.After(2 * time.Second):
		_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
		<-d.done
	}
	d.cmd = nil
	d.done = nil
	_ = os.Remove(d.socketPath)
}

func dashboardMiddleware(dashboard *dashboardDaemon) wish.Middleware {
	return func(next ssh.Handler) ssh.Handler {
		return func(session ssh.Session) {
			_ = next

			conn, err := dashboard.dial()
			if err != nil {
				_, _ = fmt.Fprintf(session, "failed to connect to dashboard: %v\r\n", err)
				_ = session.Exit(1)
				return
			}
			defer conn.Close()
			defer dashboard.clientDisconnected()

			copyDone := make(chan error, 1)
			go func() {
				_, err := io.Copy(session, conn)
				copyDone <- err
			}()

			inputDone := make(chan struct{})
			go watchExitKeys(session, inputDone)

			signals := make(chan ssh.Signal, 8)
			session.Signals(signals)
			defer session.Signals(nil)
			signalDone := make(chan struct{})
			go watchExitSignals(signals, signalDone)

			select {
			case <-session.Context().Done():
				_ = conn.Close()
			case <-inputDone:
				_ = conn.Close()
				restoreTerminal(session)
				_ = session.Exit(0)
			case <-signalDone:
				_ = conn.Close()
				restoreTerminal(session)
				_ = session.Exit(0)
			case err := <-copyDone:
				if err != nil {
					_ = session.Exit(1)
					return
				}
			}
		}
	}
}

func restoreTerminal(writer io.Writer) {
	_, _ = writer.Write([]byte("\x1b[?25h\x1b[?1049l"))
}

func watchExitSignals(signals <-chan ssh.Signal, done chan<- struct{}) {
	for sig := range signals {
		if sig == ssh.SIGINT || sig == ssh.SIGTERM || sig == ssh.SIGQUIT || sig == ssh.SIGKILL {
			close(done)
			return
		}
	}
}

func watchExitKeys(reader io.Reader, done chan<- struct{}) {
	buf := make([]byte, 32)
	for {
		n, err := reader.Read(buf)
		if err != nil {
			return
		}

		for _, b := range buf[:n] {
			if b == 0x03 || b == 'q' || b == 'Q' {
				close(done)
				return
			}
		}
	}
}

func envString(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

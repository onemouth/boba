package main

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const defaultMaxTokens = 16384

type config struct {
	APIKey    string `json:"api_key"`
	Model     string `json:"model"`
	Port      int    `json:"port"`
	Token     string `json:"pairing_token"`
	MaxTokens int    `json:"max_tokens"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}
	flags := flag.NewFlagSet("boba "+command, flag.ContinueOnError)
	configPath := flags.String("config", "config.json", "project configuration file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if command == "init" {
		return initConfig(*configPath)
	}
	if command == "userscript" {
		fmt.Print(userscript)
		return nil
	}
	if command != "serve" {
		return fmt.Errorf("usage: boba [init|serve|userscript] [-config path]")
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	workspace := filepath.Join(home, "Documents", "boba")
	// Keep server secrets outside the model-accessible workspace.
	absConfig, err := filepath.Abs(*configPath)
	if err != nil {
		return err
	}
	realConfig, err := filepath.EvalSymlinks(absConfig)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return err
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return err
	}
	if rel, err := filepath.Rel(workspace, realConfig); err == nil && filepath.IsLocal(rel) {
		return errors.New("config must be outside ~/Documents/boba")
	}
	ws, err := openWorkspace(workspace, filepath.Join(home, ".Trash"))
	if err != nil {
		return err
	}
	defer ws.Close()
	app := newApp(cfg, ws)
	server := &http.Server{
		Addr:              net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)),
		Handler:           app.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      3 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("Boba listening on http://%s — workspace %s", server.Addr, workspace)
	log.Print("Install userscript/boba.user.js in Violentmonkey; configure its server URL and pairing token.")
	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func initConfig(path string) error {
	cfg := config{Model: "openai/gpt-4.1-mini", Port: 8787, Token: rand.Text(), MaxTokens: defaultMaxTokens}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	fmt.Printf("Created %s. Set api_key and model, then run boba serve.\n", path)
	return nil
}

func loadConfig(path string) (config, error) {
	var cfg config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read config (run boba init first): %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	cfg.MaxTokens = cmp.Or(cfg.MaxTokens, defaultMaxTokens)
	if cfg.MaxTokens < 1 {
		return cfg, errors.New("max_tokens must be a positive integer, or omitted for the 16384 default")
	}
	if cfg.APIKey == "" || cfg.Model == "" || len(cfg.Token) < 24 || cfg.Port < 1 || cfg.Port > 65535 {
		return cfg, errors.New("config requires api_key, model, port (1–65535), and pairing_token (at least 24 characters)")
	}
	return cfg, nil
}

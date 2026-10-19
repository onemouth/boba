//go:build !darwin

package main

import "os/exec"

// bash refuses unsupported platforms before process creation.
func configureBashProcess(cmd *exec.Cmd) {}
func killBashGroup(cmd *exec.Cmd) error  { return nil }

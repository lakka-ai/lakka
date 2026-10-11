// Caddy, built by us from its release with current dependencies (ADR 0086): the same program as
// the upstream binary, with the standard modules, compiled with a Go toolchain and modules that
// carry the fixes the image scan requires (NF-S7). go.mod pins the Caddy release and each bumped
// module; go.sum pins every hash.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}

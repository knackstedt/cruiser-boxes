#!/usr/bin/env bun
// ============================================================================
// cli.ts — headless control surface for cruiser.
//
//   bun run src/cli.ts vm list
//   bun run src/cli.ts vm create <name> [--source cloudimg:ubuntu-26.04|iso:…]
//   bun run src/cli.ts vm start|stop|kill <name>
//   bun run src/cli.ts vm viewer <name> [--mode …]
//   bun run src/cli.ts vm snapshot|restore|backup|resize <name> …
//   bun run src/cli.ts usb ls|attach|detach …
//   bun run src/cli.ts wm desktops|monitors|switch-desktop <n>
//   bun run src/cli.ts provision|toolchain check|doctor
//
// The UI drives the same libraries; this CLI is also what escape shortcuts
// and .desktop files invoke.
// ============================================================================

export {};

const [,, ...argv] = process.argv;

function usage(): never {
    console.log(`cruiser — QEMU/KVM VM manager for Linux guests

usage: cruiser <area> <command> [args]

areas:
  vm          list | create | start | stop | kill | status | viewer |
              snapshot | restore | backup | resize | delete
  usb         ls | attach | detach
  wm          desktops | monitors | switch-desktop <n>
  provision   cloudimg <vm> <release> | iso <vm> <iso-path>
  toolchain   check | build [--component …]
  doctor      host dependency + permission report
`);
    process.exit(2);
}

async function main() {
    const area = argv.shift();
    const cmd = argv.shift();
    if (!area) usage();
    console.log(`cruiser ${area} ${cmd ?? ""} — not implemented yet (phase ${area === "vm" ? 3 : area === "toolchain" ? 2 : "?"} pending)`);
    process.exit(1);
}

await main();

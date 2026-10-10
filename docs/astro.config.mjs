// @ts-check
import { defineConfig, passthroughImageService } from "astro/config";
import starlight from "@astrojs/starlight";

// Custom-domain deployment: https://cruiser.dev (public/CNAME).
// If the domain changes, update `site` + public/CNAME; if the site ever
// moves under a subpath, set base (or DOCS_BASE in the workflow env) and
// re-prefix the internal content links to match.
const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
    site: "https://cruiser.dev",
    base,
    // No astro:assets processing — avoids the sharp native dep.
    image: { service: passthroughImageService() },
    integrations: [
        starlight({
            title: "Cruiser",
            description:
                "QEMU/KVM VM manager for Linux guests — GPU-accelerated VMs integrated into the host desktop.",
            logo: { src: "./src/assets/logo.svg", replacesTitle: false },
            favicon: "/favicon.svg",
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/knackstedt/cruiser-boxes",
                },
            ],
            editLink: {
                baseUrl: "https://github.com/knackstedt/cruiser-boxes/edit/main/docs/",
            },
            lastUpdated: true,
            customCss: ["./src/styles/custom.css"],
            sidebar: [
                {
                    label: "Start here",
                    items: [
                        { label: "Overview", slug: "overview" },
                        { label: "Installation", slug: "installation" },
                        { label: "Quickstart", slug: "quickstart" },
                    ],
                },
                {
                    label: "Guides",
                    items: [
                        { label: "Creating VMs", slug: "guides/creating-vms" },
                        { label: "Provisioning", slug: "guides/provisioning" },
                        { label: "Viewing & head modes", slug: "guides/viewing" },
                        { label: "App mode (waypipe)", slug: "guides/app-mode" },
                        { label: "File sharing", slug: "guides/file-sharing" },
                        { label: "USB passthrough", slug: "guides/usb" },
                        { label: "Snapshots, backups & resize", slug: "guides/snapshots" },
                        { label: "Logs", slug: "guides/logs" },
                        { label: "Troubleshooting", slug: "guides/troubleshooting" },
                    ],
                },
                {
                    label: "Reference",
                    items: [
                        { label: "CLI reference", slug: "reference/cli" },
                        { label: "vm.json (VmSpec)", slug: "reference/vm-spec" },
                        { label: "Environment variables", slug: "reference/env" },
                        { label: "Storage layout", slug: "reference/storage" },
                        { label: "Distro matrix", slug: "reference/distros" },
                    ],
                },
                {
                    label: "Internals",
                    items: [
                        { label: "Architecture", slug: "internals/architecture" },
                        { label: "QEMU toolchain", slug: "internals/toolchain" },
                        { label: "DE / session matrix", slug: "internals/de-matrix" },
                        { label: "Rendering futures", slug: "internals/rendering-futures" },
                        { label: "VFIO design note", slug: "internals/vfio" },
                    ],
                },
                {
                    label: "Development",
                    items: [{ label: "Hacking on cruiser", slug: "development" }],
                },
            ],
        }),
    ],
});

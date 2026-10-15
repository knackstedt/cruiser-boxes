// ============================================================================
// devtools.ts — guest-setup script snippets for devtools that don't come from
// the distro: upstream installers (fnm/bun/deno/zed/k3s/tailscale/ollama),
// third-party repos (hashicorp, github cli, mongodb, microsoft, windsurf),
// single-binary drops (kubectl/kind/minikube/k9s/yq), and the service/group
// plumbing the distro packages leave undone (docker, mysql, postgres, redis,
// libvirt).
//
// Emitted into guestSetupScript after the flatpak section — expects $U/$UHOME
// (user + home) and runs as root under `set -eu`. Every block is wrapped in
// `( set -e; … ) || echo "skipped"` so one broken upstream can't fail the
// whole provision.
// ============================================================================

import type { DevTool } from "../../vm-core/src/config/schema";
import type { GuestProfile } from "./packages";

/**
 * Bash for the script-installed devtools selected on the profile.
 * Returns "" when nothing needs a script.
 */
export function guestDevtoolsScript(p: GuestProfile): string {
    const sel = new Set<DevTool>(p.devtools);
    const blocks: string[] = [];
    const add = (id: DevTool, body: string) => {
        if (!sel.has(id)) return;
        blocks.push(`# ${id}
( set -e
${body}
) || echo "guest-setup: devtools '${id}' failed — skipped" >&2`);
    };

    // ── languages & runtimes ──
    add("node", `  u_run curl -fsSL https://fnm.vercel.app/install -o /tmp/fnm-install.sh
  u_run bash /tmp/fnm-install.sh --skip-shell </dev/null
  FNM="$UHOME/.local/share/fnm/fnm"; [ -x "$FNM" ] || FNM="$UHOME/.fnm/fnm"
  u_run "$FNM" install --lts
  u_run "$FNM" alias lts-latest default 2>/dev/null || true
  u_path 'eval "$("$HOME/.local/share/fnm/fnm" env --use-on-cd)" 2>/dev/null || true'`);
    add("bun", `  u_run bash -c 'curl -fsSL https://bun.sh/install | bash' </dev/null
  u_path 'export PATH="$HOME/.bun/bin:$PATH"'`);
    add("deno", `  u_run bash -c 'curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path' </dev/null \
      || u_run bash -c 'curl -fsSL https://deno.land/install.sh | sh' </dev/null
  u_path 'export PATH="$HOME/.deno/bin:$PATH"'`);
    add("uv", `  # distro build preferred (already installed by the pkg pass) — script fallback
  command -v uv >/dev/null 2>&1 && exit 0
  u_run bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh' </dev/null
  u_path 'export PATH="$HOME/.local/bin:$PATH"'`);
    add("csharp", `  u_run bash -c 'curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && bash /tmp/dotnet-install.sh --channel LTS' </dev/null
  u_path 'export DOTNET_ROOT="$HOME/.dotnet"'
  u_path 'export PATH="$HOME/.dotnet:$PATH"'`);

    // ── cli & shell ──
    add("yq", `  # the distro 'yq' is a different (python) tool — take mikefarah's binary
  curl -fsSLo /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$(dl_arch)"
  chmod +x /usr/local/bin/yq`);
    add("gh", `  if command -v apt-get >/dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
        > /etc/apt/sources.list.d/github-cli.list
    apt-get update -qq
    apt-get install -y gh
  else
    DNF=dnf5; command -v dnf5 >/dev/null || DNF=dnf
    $DNF install -y 'dnf-command(config-manager)' 2>/dev/null || true
    $DNF config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
    $DNF install -y gh
  fi`);

    // ── editors ──
    add("zed", `  u_run bash -c 'curl -f https://zed.dev/install.sh | sh' </dev/null`);
    add("cursor", `  J=$(curl -fsSL "https://cursor.com/api/download?platform=linux-x64&releaseTrack=stable")
  if command -v apt-get >/dev/null; then
    CU=$(printf '%s' "$J" | sed -n 's/.*"debUrl":"\\([^"]*\\)".*/\\1/p')
    [ -n "$CU" ]
    curl -fsSL "$CU" -o /tmp/cursor.deb
    apt-get install -y /tmp/cursor.deb
  elif command -v dnf5 >/dev/null || command -v dnf >/dev/null; then
    CU=$(printf '%s' "$J" | sed -n 's/.*"rpmUrl":"\\([^"]*\\)".*/\\1/p')
    [ -n "$CU" ]
    curl -fsSL "$CU" -o /tmp/cursor.rpm
    dnf5 install -y /tmp/cursor.rpm 2>/dev/null || dnf install -y /tmp/cursor.rpm
  else
    # appimage fallback — the base manifest already ships libfuse for these
    CU=$(printf '%s' "$J" | sed -n 's/.*"downloadUrl":"\\([^"]*\\)".*/\\1/p')
    [ -n "$CU" ]
    curl -fsSL "$CU" -o /opt/cursor.AppImage
    chmod +x /opt/cursor.AppImage
    tee /usr/share/applications/cursor.desktop >/dev/null <<'CURDESK'
[Desktop Entry]
Name=Cursor
Exec=/opt/cursor.AppImage --no-sandbox %U
Type=Application
Categories=Development;IDE;
CURDESK
  fi`);
    add("devin-desktop", `  # windsurf repo is apt-only — nothing to do on rpm guests
  command -v apt-get >/dev/null || { echo "guest-setup: devin-desktop is deb-family only" >&2; exit 0; }
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/windsurf.gpg \\
      -o /etc/apt/keyrings/windsurf-stable.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/windsurf-stable.gpg] https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/apt stable main" \\
      > /etc/apt/sources.list.d/devin-desktop.list
  apt-get update -qq
  apt-get install -y devin-desktop`);

    // ── containers & vms ──
    add("docker", `  systemctl enable --now docker.service docker.socket 2>/dev/null \\
      || systemctl enable --now docker 2>/dev/null || true
  getent group docker >/dev/null 2>&1 || groupadd --system docker 2>/dev/null || true
  usermod -aG docker "$U"`);
    add("virtmanager", `  systemctl enable --now libvirtd.socket 2>/dev/null \\
      || systemctl enable --now libvirtd 2>/dev/null || true
  usermod -aG libvirt "$U" 2>/dev/null || usermod -aG libvirt-qemu "$U" 2>/dev/null || true
  usermod -aG kvm "$U" 2>/dev/null || true`);
    if (sel.has("terraform") || sel.has("vagrant")) {
        const want = (["terraform", "vagrant"] as const).filter((t) => sel.has(t)).join(" ");
        blocks.push(`# terraform/vagrant — hashicorp publishes one repo for both
( set -e
  if command -v apt-get >/dev/null; then
    # not every guest codename has a suite (new debian/ubuntu releases) —
    # probe the dist and fall back to a known-good one.
    . /etc/os-release
    HCSUITE="\${UBUNTU_CODENAME:-\${VERSION_CODENAME:-noble}}"
    curl -fsS -o /dev/null "https://apt.releases.hashicorp.com/dists/$HCSUITE/Release" || HCSUITE=noble
    curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $HCSUITE main" \\
        > /etc/apt/sources.list.d/hashicorp.list
    apt-get update -qq
    apt-get install -y ${want}
  elif command -v dnf5 >/dev/null || command -v dnf >/dev/null; then
    DNF=dnf5; command -v dnf5 >/dev/null || DNF=dnf
    $DNF install -y 'dnf-command(config-manager)' 2>/dev/null || true
    $DNF config-manager --add-repo https://rpm.releases.hashicorp.com/fedora/hashicorp.repo
    $DNF install -y ${want}
  fi
) || echo "guest-setup: devtools 'hashicorp' failed — skipped" >&2`);
    }

    // ── kubernetes ──
    add("kubectl", `  curl -fsSLo /usr/local/bin/kubectl \\
      "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dl_arch)/kubectl"
  chmod +x /usr/local/bin/kubectl`);
    add("helm", `  command -v helm >/dev/null 2>&1 && exit 0   # distro pkg already landed
  bash -c 'curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash' </dev/null`);
    add("k9s", `  curl -fsSL "https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_$(dl_arch).tar.gz" \\
      | tar -xzf - -C /usr/local/bin k9s`);
    add("minikube", `  curl -fsSLo /tmp/minikube "https://storage.googleapis.com/minikube/releases/latest/minikube-linux-$(dl_arch)"
  install -m 0755 /tmp/minikube /usr/local/bin/minikube`);
    add("kind", `  curl -fsSLo /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/latest/kind-linux-$(dl_arch)"
  chmod +x /usr/local/bin/kind`);
    add("k3s", `  # NB: | sh </dev/null would starve the pipe — wrap in bash -c so
  # the redirect only applies to the outer shell
  bash -c 'curl -sfL https://get.k3s.io | sh' </dev/null`);

    // ── cloud & iac ──
    add("cloudcli", `  # awscli comes from the distro pkg pass; gcloud is google's
  # user-level sdk (self-updating), az wires the MS repo itself on deb-family.
  if [ ! -d "$UHOME/google-cloud-sdk" ]; then
    GCARCH=x86_64; [ "$(uname -m)" = aarch64 ] && GCARCH=arm
    u_run bash -c "curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-$GCARCH.tar.gz -o /tmp/gcloud.tgz && tar -xzf /tmp/gcloud.tgz -C \\"\\$HOME\\"" </dev/null
    u_run "$UHOME/google-cloud-sdk/install.sh" -q --usage-reporting=false </dev/null || true
  fi
  if ! command -v az >/dev/null 2>&1; then
    if command -v apt-get >/dev/null; then
      bash -c 'curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash' </dev/null || true
    else
      u_run pipx install azure-cli 2>/dev/null || u_run python3 -m pip install --user azure-cli 2>/dev/null || true
    fi
  fi`);

    // ── databases ──
    add("mysql", `  systemctl enable --now mysqld 2>/dev/null || systemctl enable --now mysql 2>/dev/null || true`);
    add("postgres", `  # deb-family postgresql initdb's itself at pkg install; fedora's
  # postgresql-server needs an explicit first initdb before the unit will run.
  if command -v postgresql-setup >/dev/null 2>&1 && [ ! -d /var/lib/pgsql/data/base ]; then
    postgresql-setup --initdb
  fi
  systemctl enable --now postgresql 2>/dev/null || true`);
    add("redis", `  systemctl enable --now redis-server 2>/dev/null || systemctl enable --now redis 2>/dev/null || true`);
    add("mongodb", `  if command -v apt-get >/dev/null; then
    . /etc/os-release
    curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
    if [ "\${ID:-}" = debian ]; then
      MBASE=https://repo.mongodb.org/apt/debian; MC="\${VERSION_CODENAME:-bookworm}"; MCOMP=main; MFALL=bookworm
    else
      MBASE=https://repo.mongodb.org/apt/ubuntu; MC="\${UBUNTU_CODENAME:-\${VERSION_CODENAME:-noble}}"; MCOMP=multiverse; MFALL=noble
    fi
    # mongo lags brand-new releases — probe the dist, fall back to the last LTS
    curl -fsS -o /dev/null "$MBASE/dists/$MC/mongodb-org/8.0/Release" || MC=$MFALL
    echo "deb [signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] $MBASE $MC/mongodb-org/8.0 $MCOMP" \\
        > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update -qq
    apt-get install -y mongodb-org || apt-get install -y mongodb-mongosh
  elif command -v dnf5 >/dev/null || command -v dnf >/dev/null; then
    tee /etc/yum.repos.d/mongodb-org-8.0.repo >/dev/null <<'MOREPO'
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/9/mongodb-org/8.0/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-8.0.asc
MOREPO
    DNF=dnf5; command -v dnf5 >/dev/null || DNF=dnf
    $DNF install -y mongodb-org || $DNF install -y mongodb-mongosh
  fi
  systemctl enable --now mongod 2>/dev/null || true`);

    // ── network & ai ──
    add("tailscale", `  # installer detects the distro and wires tailscale's own repo
  bash -c 'curl -fsSL https://tailscale.com/install.sh | sh' </dev/null`);
    add("ollama", `  bash -c 'curl -fsSL https://ollama.com/install.sh | sh' </dev/null`);

    if (!blocks.length) return "";
    return `# ── devtools installers — upstream scripts/repos/binaries + the service
# and group plumbing the distro packages leave undone. Each block fails
# soft: a dead upstream shouldn't sink the whole provision.
# runuser -u alone keeps HOME=/root — user-level installers (fnm/bun/deno/…)
# would land in root's home. Force the real user env.
u_run() { runuser -u "$U" -- env HOME="$UHOME" USER="$U" LOGNAME="$U" "$@"; }
u_path() { # append an env line to the user's .profile once
  [ -f "$UHOME/.profile" ] || { touch "$UHOME/.profile"; chown "$U":"$U" "$UHOME/.profile"; }
  grep -qF "$1" "$UHOME/.profile" || echo "$1" >> "$UHOME/.profile"
}
dl_arch() { case "$(uname -m)" in x86_64) echo amd64 ;; aarch64) echo arm64 ;; *) uname -m ;; esac }

${blocks.join("\n\n")}
`;
}
